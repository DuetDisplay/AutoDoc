import { app } from 'electron'
import { createHash } from 'crypto'
import {
  access,
  mkdir,
  copyFile,
  rm,
  readdir,
  symlink,
  chmod,
  mkdtemp,
  writeFile,
  rename
} from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createReadStream, createWriteStream } from 'fs'
import { execFile, execSync } from 'child_process'
import { EventEmitter, once } from 'events'
import { tmpdir } from 'os'
import ffmpegStatic from 'ffmpeg-static'
import { MODELS_SUBDIR } from '../../shared/constants'
import type { WhisperSetupStatus } from '../../shared/types'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { getInstalledModelsDir } from './dev-runtime-paths'
import { getStorageDiagnostics } from './storage-manager'
import {
  canUseSystemRuntimeFallback,
  canUseSystemWhisperFallback,
  usesManagedRuntimeOnly
} from './runtime-policy'
import {
  detectWindowsHardwareProfile,
  loadWindowsTranscriptionProfiles,
  selectWindowsTranscriptionProfile,
  WINDOWS_TRANSCRIPTION_PROFILES,
  type WindowsTranscriptionBackendId,
  type WindowsTranscriptionProfile
} from './windows-transcription-runtime'

const IS_WIN = process.platform === 'win32'

// Pinned release versions for reproducibility
const WHISPER_VERSION = 'v1.8.4'
const WHISPER_WIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
const FFMPEG_WIN_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
const WHISPER_PROBE_TIMEOUT_MS = 30_000
const WHISPER_PROBE_RETRY_DELAYS_MS = [500, 1_500]
const FASTER_WHISPER_PROBE_TIMEOUT_MS = 45_000
const HOMEBREW_API_ROOT = 'https://formulae.brew.sh/api/formula'
const MAC_WHISPER_FORMULA = 'whisper-cpp'
const MAC_GGML_FORMULA = 'ggml'
const MAC_LIBOMP_FORMULA = 'libomp'

type WhisperUsabilityResult = 'ready' | 'missing-assets' | 'slow-validation' | 'failed'

const DEFAULT_MODEL = IS_WIN
  ? {
      filename: 'ggml-distil-large-v3.bin',
      downloadUrl:
        'https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin'
    }
  : {
      filename: 'ggml-large-v3.bin',
      downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
    }

export interface WhisperModelInfo {
  filename: string
  downloadUrl: string
}

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

interface HomebrewBottleFile {
  url?: string
}

interface HomebrewFormulaResponse {
  versions?: {
    stable?: string
  }
  bottle?: {
    stable?: {
      files?: Record<string, HomebrewBottleFile>
    }
  }
}

export class WhisperManager extends EventEmitter {
  private setupPromise: Promise<void> | null = null
  private setupStatus: WhisperSetupStatus = { phase: 'checking', percent: 0 }
  private runtimeValidated = false
  private selectedWindowsProfile: WindowsTranscriptionProfile | null = null
  private windowsTranscriptionProfiles: Record<
    WindowsTranscriptionBackendId,
    WindowsTranscriptionProfile
  > = WINDOWS_TRANSCRIPTION_PROFILES

  constructor() {
    super()
  }

  getModelsDir(): string {
    return join(app.getPath('userData'), MODELS_SUBDIR)
  }

  getWhisperPath(): string {
    return join(this.getModelsDir(), IS_WIN ? 'whisper-cli.exe' : 'whisper-cpp')
  }

  getFfmpegPath(): string {
    return join(this.getModelsDir(), IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')
  }

  getModelPath(): string {
    return join(this.getModelsDir(), this.getModelInfo().filename)
  }

  getModelInfo(): WhisperModelInfo {
    return DEFAULT_MODEL
  }

  getModelName(): string {
    const profile = this.selectedWindowsProfile
    if (profile && profile.id !== 'whisper-cpp') {
      return profile.modelName
    }

    return this.getModelInfo()
      .filename.replace(/^ggml-/, '')
      .replace(/\.bin$/i, '')
  }

  getTranscriptionBackend(): WindowsTranscriptionBackendId {
    return this.selectedWindowsProfile?.id ?? 'whisper-cpp'
  }

  getTranscriptionBackendLabel(): string {
    return (
      this.selectedWindowsProfile?.label ?? this.windowsTranscriptionProfiles['whisper-cpp'].label
    )
  }

  isFasterWhisperSelected(): boolean {
    return IS_WIN && this.getTranscriptionBackend() !== 'whisper-cpp'
  }

  getFasterWhisperPythonPath(): string {
    return join(this.getFasterWhisperRuntimeDir(), 'python.exe')
  }

  getFasterWhisperModelPath(): string {
    const profile = this.getSelectedWindowsProfile()
    return join(this.getModelsDir(), 'faster-whisper-models', profile.modelName)
  }

  getFasterWhisperScriptPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'faster-whisper-transcribe.py')
    }
    return join(app.getAppPath(), 'resources', 'faster-whisper-transcribe.py')
  }

  getFasterWhisperDevice(): 'cuda' | 'cpu' {
    return this.getSelectedWindowsProfile().device
  }

  getFasterWhisperComputeType(): 'float16' | 'int8' {
    return this.getSelectedWindowsProfile().computeType
  }

  getSetupStatus(): WhisperSetupStatus {
    return { ...this.setupStatus }
  }

  private getSelectedWindowsProfile(): WindowsTranscriptionProfile {
    if (!this.selectedWindowsProfile) {
      this.selectedWindowsProfile = this.windowsTranscriptionProfiles['whisper-cpp']
    }

    return this.selectedWindowsProfile
  }

  private getFasterWhisperRuntimeDir(profile = this.getSelectedWindowsProfile()): string {
    return join(this.getModelsDir(), 'transcription-runtimes', profile.id)
  }

  private getFasterWhisperAssetRoot(
    profile: WindowsTranscriptionProfile,
    assetId: 'runtime' | 'model'
  ): string {
    return assetId === 'runtime'
      ? this.getFasterWhisperRuntimeDir(profile)
      : join(this.getModelsDir(), 'faster-whisper-models', profile.modelName)
  }

  private withBackendStatus(status: WhisperSetupStatus): WhisperSetupStatus {
    if (!IS_WIN) {
      return status
    }

    const profile = this.getSelectedWindowsProfile()
    return {
      ...status,
      backend: profile.id,
      backendLabel: profile.label
    }
  }

  private async selectWindowsProfile(): Promise<void> {
    if (!IS_WIN) {
      this.selectedWindowsProfile = null
      return
    }

    const hardware = await detectWindowsHardwareProfile()
    this.windowsTranscriptionProfiles = await loadWindowsTranscriptionProfiles(
      this.getWindowsTranscriptionManifestPath()
    )
    this.selectedWindowsProfile = selectWindowsTranscriptionProfile(
      hardware,
      this.windowsTranscriptionProfiles
    )
    logAutodocEvent({
      area: 'whisper',
      message: 'Selected Windows transcription backend',
      context: {
        backend: this.selectedWindowsProfile.id,
        backendLabel: this.selectedWindowsProfile.label,
        modelName: this.selectedWindowsProfile.modelName,
        hardware
      }
    })
  }

  private getWindowsTranscriptionManifestPath(): string {
    if (app.isPackaged) {
      return join(
        process.resourcesPath ?? this.getDevelopmentAppPath(),
        'windows-transcription-manifest.json'
      )
    }

    return join(this.getDevelopmentAppPath(), 'resources', 'windows-transcription-manifest.json')
  }

  private getDevelopmentAppPath(): string {
    return typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  }

  async isReady(): Promise<boolean> {
    try {
      if (this.isFasterWhisperSelected()) {
        await access(this.getFasterWhisperPythonPath())
        await access(this.getFasterWhisperModelPath())
        await access(this.getFfmpegPath())
        return this.runtimeValidated
      }

      await access(this.getWhisperPath())
      await access(this.getModelPath())
      await access(this.getFfmpegPath())
      return this.runtimeValidated
    } catch {
      return false
    }
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startSetup(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = this.runSetup().finally(() => {
        this.setupPromise = null
      })
    }
    return this.setupPromise
  }

  private async runSetup(): Promise<void> {
    try {
      await this.ensureReady()
      this.setupStatus = this.withBackendStatus({ phase: 'ready', percent: 100 })
      this.emit('setup-status', this.getSetupStatus())
    } catch (err) {
      this.setupStatus = this.withBackendStatus({
        phase: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : String(err)
      })
      this.emit('setup-status', this.getSetupStatus())
      throw err
    }
  }

  async ensureReady(): Promise<void> {
    try {
      await mkdir(this.getModelsDir(), { recursive: true })
      await this.selectWindowsProfile()
      this.setupStatus = this.withBackendStatus({ phase: 'checking', percent: 0 })
      this.emit('setup-status', this.getSetupStatus())

      await this.adoptInstalledAssetsIfAvailable()

      if (this.isFasterWhisperSelected()) {
        try {
          await this.ensureFasterWhisperReady()
          return
        } catch (err) {
          logAutodocFailure({
            area: 'whisper',
            message: 'Faster Whisper setup failed; falling back to whisper.cpp',
            error: err,
            context: {
              backend: this.getTranscriptionBackend(),
              backendLabel: this.getTranscriptionBackendLabel()
            }
          })
          this.selectedWindowsProfile = this.windowsTranscriptionProfiles['whisper-cpp']
          this.runtimeValidated = false
          this.setupStatus = this.withBackendStatus({ phase: 'checking', percent: 0 })
          this.emit('setup-status', this.getSetupStatus())
        }
      }

      const [hasWhisperBinary, hasFfmpegBinary, hasModelFile] = await Promise.all([
        this.fileExists(this.getWhisperPath()),
        this.fileExists(this.getFfmpegPath()),
        this.fileExists(this.getModelPath())
      ])

      if (!hasWhisperBinary || !hasFfmpegBinary || !hasModelFile) {
        logAutodocEvent({
          area: 'whisper',
          message: 'Whisper managed asset check detected missing files before setup',
          context: {
            hasWhisperBinary,
            hasFfmpegBinary,
            hasModelFile,
            diagnostics: await getStorageDiagnostics({
              whisperBinaryPath: this.getWhisperPath(),
              ffmpegPath: this.getFfmpegPath(),
              whisperModelPath: this.getModelPath()
            })
          }
        })
      }

      if (!hasWhisperBinary) {
        this.setupStatus = this.withBackendStatus({ phase: 'downloading-whisper', percent: 0 })
        this.emit('setup-status', this.getSetupStatus())
        await this.resolveWhisper()
      }
      if (!hasFfmpegBinary) {
        this.setupStatus = this.withBackendStatus({ phase: 'downloading-ffmpeg', percent: 0 })
        this.emit('setup-status', this.getSetupStatus())
        await this.resolveFfmpeg()
      }
      if (!hasModelFile) {
        this.setupStatus = this.withBackendStatus({ phase: 'downloading-model', percent: 0 })
        this.emit('setup-status', this.getSetupStatus())
        await this.downloadWithRetry(() => this.downloadModel(), 'model')
      }

      let usability = await this.isWhisperUsableWithRetry()

      if (!this.isWhisperUsabilityAccepted(usability)) {
        await this.recoverFromProbeValidationFailure()
        usability = await this.isWhisperUsableWithRetry()
      }

      if (!this.isWhisperUsabilityAccepted(usability)) {
        this.setupStatus = this.withBackendStatus({ phase: 'downloading-whisper', percent: 0 })
        this.emit('setup-status', this.getSetupStatus())
        await this.resolveWhisper()
        usability = await this.isWhisperUsableWithRetry()
        if (!this.isWhisperUsabilityAccepted(usability)) {
          throw new Error(
            IS_WIN
              ? 'whisper-cli failed startup validation after setup. Required Windows runtime files may be missing.'
              : 'whisper-cli failed startup validation after setup.'
          )
        }
      }

      this.runtimeValidated = true

      this.setupStatus = this.withBackendStatus({ phase: 'ready', percent: 100 })
      this.emit('setup-status', this.getSetupStatus())
    } catch (err) {
      this.setupStatus = this.withBackendStatus({
        phase: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : String(err),
        failedStep: this.getFailedStep()
      })
      this.emit('setup-status', this.getSetupStatus())
      throw err
    }
  }

  private async ensureFasterWhisperReady(): Promise<void> {
    const profile = this.getSelectedWindowsProfile()
    await this.ensureFfmpegForSelectedRuntime()

    for (const asset of profile.assets) {
      const assetRoot = this.getFasterWhisperAssetRoot(profile, asset.id)
      const hasAsset = await this.hasExpectedFiles(assetRoot, asset.expectedFiles)
      if (hasAsset) {
        continue
      }

      this.setupStatus = this.withBackendStatus({
        phase: asset.id === 'runtime' ? 'downloading-whisper' : 'downloading-model',
        percent: 0
      })
      this.emit('setup-status', this.getSetupStatus())
      await this.downloadWithRetry(
        () => this.downloadAndExtractWindowsTranscriptionAsset(profile, asset),
        asset.id
      )
    }

    if (!(await this.isFasterWhisperUsableWithRetry())) {
      throw new Error(`${profile.label} failed startup validation after setup.`)
    }

    this.runtimeValidated = true
    this.setupStatus = this.withBackendStatus({ phase: 'ready', percent: 100 })
    this.emit('setup-status', this.getSetupStatus())
  }

  private async ensureFfmpegForSelectedRuntime(): Promise<void> {
    if (await this.fileExists(this.getFfmpegPath())) {
      return
    }

    this.setupStatus = this.withBackendStatus({ phase: 'downloading-ffmpeg', percent: 0 })
    this.emit('setup-status', this.getSetupStatus())
    await this.resolveFfmpeg()
  }

  private async downloadAndExtractWindowsTranscriptionAsset(
    profile: WindowsTranscriptionProfile,
    asset: WindowsTranscriptionProfile['assets'][number]
  ): Promise<void> {
    const modelsDir = this.getModelsDir()
    const archivePath = join(modelsDir, asset.filename)
    const targetDir = this.getFasterWhisperAssetRoot(profile, asset.id)

    await mkdir(targetDir, { recursive: true })
    await this.downloadFile(asset.url, archivePath, asset.filename, (p) => {
      this.setupStatus = this.withBackendStatus({
        phase: asset.id === 'runtime' ? 'downloading-whisper' : 'downloading-model',
        percent: p
      })
      this.emit('setup-status', this.getSetupStatus())
    })
    await this.verifyFileSha256(archivePath, asset.sha256, asset.filename)

    await rm(targetDir, { recursive: true, force: true })
    await mkdir(targetDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${targetDir}'`
        ],
        (err) => {
          if (err) reject(new Error(`Failed to extract ${asset.filename}: ${err.message}`))
          else resolve()
        }
      )
    })

    await rm(archivePath, { force: true })
  }

  private async hasExpectedFiles(rootDir: string, expectedFiles: string[]): Promise<boolean> {
    for (const expectedFile of expectedFiles) {
      if (!(await this.fileExists(join(rootDir, ...expectedFile.split('/'))))) {
        return false
      }
    }

    return true
  }

  private async verifyFileSha256(
    filePath: string,
    expectedSha256: string,
    label: string
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
      throw new Error(`Missing or invalid SHA256 for ${label}.`)
    }

    const actualSha256 = await this.hashFileSha256(filePath)
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      await rm(filePath, { force: true })
      throw new Error(
        `Downloaded ${label} failed SHA256 verification: expected ${expectedSha256}, received ${actualSha256}.`
      )
    }
  }

  private hashFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(filePath)

      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private async recoverFromProbeValidationFailure(): Promise<void> {
    this.setupStatus = this.withBackendStatus({ phase: 'downloading-model', percent: 0 })
    this.emit('setup-status', this.getSetupStatus())

    logAutodocEvent({
      area: 'whisper',
      message: 'Whisper probe validation failed; removing managed model before redownload',
      context: {
        diagnostics: await getStorageDiagnostics({
          whisperModelPath: this.getModelPath(),
          whisperBinaryPath: this.getWhisperPath(),
          ffmpegPath: this.getFfmpegPath()
        })
      }
    })
    await rm(this.getModelPath(), { force: true })
    await this.downloadWithRetry(() => this.downloadModel(), 'model')
  }

  private async adoptInstalledAssetsIfAvailable(): Promise<void> {
    const installedModelsDir = getInstalledModelsDir()
    if (!installedModelsDir || installedModelsDir === this.getModelsDir()) {
      return
    }

    await this.copyIfMissing(
      join(installedModelsDir, basename(this.getWhisperPath())),
      this.getWhisperPath()
    )
    await this.copyIfMissing(
      join(installedModelsDir, basename(this.getFfmpegPath())),
      this.getFfmpegPath()
    )
    await this.copyIfMissing(
      join(installedModelsDir, basename(this.getModelPath())),
      this.getModelPath()
    )

    if (!IS_WIN) {
      return
    }

    let entries
    try {
      entries = await readdir(installedModelsDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) {
        continue
      }

      await this.copyIfMissing(
        join(installedModelsDir, entry.name),
        join(this.getModelsDir(), entry.name)
      )
    }
  }

  private async resolveWhisper(): Promise<void> {
    const binaryName = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli'
    if (canUseSystemWhisperFallback()) {
      const systemPath = this.findSystemBinary(binaryName)
      if (systemPath) {
        if (IS_WIN) {
          await this.copyWhisperBundle(systemPath, this.getWhisperPath())
        } else {
          await this.linkOrCopy(systemPath, this.getWhisperPath())
        }
        return
      }
    }

    if (IS_WIN) {
      await this.downloadWhisperWindows()
      return
    }

    await this.downloadWhisperMac()
  }

  private async resolveFfmpeg(): Promise<void> {
    const packagedFfmpegPath = await this.resolvePackagedFfmpegPath()
    if (packagedFfmpegPath) {
      await this.installBundledBinary(packagedFfmpegPath, this.getFfmpegPath())
      return
    }

    if (canUseSystemRuntimeFallback()) {
      const binaryName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
      const systemPath = this.findSystemBinary(binaryName)
      if (systemPath) {
        await this.linkOrCopy(systemPath, this.getFfmpegPath())
        return
      }
    }

    if (IS_WIN) {
      await this.downloadFfmpegWindows()
      return
    }

    throw new Error(
      'AutoDoc could not finish setting up its audio tools. Please reinstall AutoDoc and try again.'
    )
  }

  private async downloadWhisperWindows(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const zipPath = join(modelsDir, 'whisper.zip')

    await this.downloadFile(WHISPER_WIN_URL, zipPath, 'whisper-cli', (p) => {
      this.setupStatus = this.withBackendStatus({ phase: 'downloading-whisper', percent: p })
      this.emit('setup-status', this.getSetupStatus())
    })

    const extractDir = join(modelsDir, '_whisper_extract')
    await mkdir(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'`
        ],
        (err) => {
          if (err) reject(new Error(`Failed to extract whisper: ${err.message}`))
          else resolve()
        }
      )
    })

    // Find whisper-cli.exe in the extracted directory (may be nested)
    const whisperExe =
      (await this.findFileRecursive(extractDir, 'whisper-cli.exe')) ??
      (await this.findFileRecursive(extractDir, 'main.exe'))

    if (!whisperExe) {
      throw new Error('whisper-cli.exe not found in downloaded archive')
    }

    await this.copyWhisperBundle(whisperExe, this.getWhisperPath())
    await rm(zipPath, { force: true })
    await rm(extractDir, { recursive: true, force: true })
  }

  private async downloadFfmpegWindows(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const zipPath = join(modelsDir, 'ffmpeg.zip')

    await this.downloadFile(FFMPEG_WIN_URL, zipPath, 'ffmpeg', (p) => {
      this.setupStatus = this.withBackendStatus({ phase: 'downloading-ffmpeg', percent: p })
      this.emit('setup-status', this.getSetupStatus())
    })

    const extractDir = join(modelsDir, '_ffmpeg_extract')
    await mkdir(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'`
        ],
        (err) => {
          if (err) reject(new Error(`Failed to extract ffmpeg: ${err.message}`))
          else resolve()
        }
      )
    })

    // ffmpeg.exe is inside a subdirectory (e.g., ffmpeg-master-.../bin/ffmpeg.exe)
    const ffmpegExe = await this.findFileRecursive(extractDir, 'ffmpeg.exe')
    if (!ffmpegExe) {
      throw new Error('ffmpeg.exe not found in downloaded archive')
    }

    await copyFile(ffmpegExe, this.getFfmpegPath())
    await chmod(this.getFfmpegPath(), 0o755)
    await rm(zipPath, { force: true })
    await rm(extractDir, { recursive: true, force: true })
  }

  private async downloadWhisperMac(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const extractDir = join(modelsDir, '_whisper_extract')
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })

    const bottleTag = this.getMacHomebrewBottleTag()
    const whisperFormula = await this.fetchHomebrewFormula(MAC_WHISPER_FORMULA)
    const ggmlFormula = await this.fetchHomebrewFormula(MAC_GGML_FORMULA)
    const libompFormula = await this.fetchHomebrewFormula(MAC_LIBOMP_FORMULA)
    const whisperUrl = this.getHomebrewBottleUrl(whisperFormula, bottleTag, MAC_WHISPER_FORMULA)
    const ggmlUrl = this.getHomebrewBottleUrl(ggmlFormula, bottleTag, MAC_GGML_FORMULA)
    const libompUrl = this.getHomebrewBottleUrl(libompFormula, bottleTag, MAC_LIBOMP_FORMULA)
    const whisperArchivePath = join(extractDir, 'whisper-cpp.tar.gz')
    const ggmlArchivePath = join(extractDir, 'ggml.tar.gz')
    const libompArchivePath = join(extractDir, 'libomp.tar.gz')

    await this.downloadGhcrBottle(whisperUrl, MAC_WHISPER_FORMULA, whisperArchivePath, (p) => {
      this.setupStatus = this.withBackendStatus({
        phase: 'downloading-whisper',
        percent: Math.round(p / 2)
      })
      this.emit('setup-status', this.getSetupStatus())
    })
    await this.extractTarGz(whisperArchivePath, extractDir)

    await this.downloadGhcrBottle(ggmlUrl, MAC_GGML_FORMULA, ggmlArchivePath, (p) => {
      this.setupStatus = this.withBackendStatus({
        phase: 'downloading-whisper',
        percent: 50 + Math.round(p / 2)
      })
      this.emit('setup-status', this.getSetupStatus())
    })
    await this.extractTarGz(ggmlArchivePath, extractDir)

    await this.downloadGhcrBottle(libompUrl, MAC_LIBOMP_FORMULA, libompArchivePath)
    await this.extractTarGz(libompArchivePath, extractDir)

    const whisperCli = await this.findFileRecursive(extractDir, 'whisper-cli')
    if (!whisperCli) {
      throw new Error('AutoDoc could not unpack the transcription runtime for macOS.')
    }

    await copyFile(whisperCli, this.getWhisperPath())
    await chmod(this.getWhisperPath(), 0o755)

    await this.copyMatchingFiles(
      join(
        extractDir,
        MAC_WHISPER_FORMULA,
        whisperFormula.versions?.stable ?? WHISPER_VERSION.replace(/^v/, ''),
        'lib'
      ),
      /^libwhisper.*\.dylib$/i,
      modelsDir
    )
    await this.copyMatchingFiles(
      join(extractDir, MAC_GGML_FORMULA, ggmlFormula.versions?.stable ?? '', 'lib'),
      /^libggml.*\.dylib$/i,
      modelsDir
    )
    await this.copyMatchingFiles(
      join(extractDir, MAC_GGML_FORMULA, ggmlFormula.versions?.stable ?? '', 'libexec'),
      /^libggml.*\.so$/i,
      modelsDir
    )
    await this.copyMatchingFiles(
      join(extractDir, MAC_LIBOMP_FORMULA, libompFormula.versions?.stable ?? '', 'lib'),
      /^libomp.*\.dylib$/i,
      modelsDir
    )

    await this.ensureMacCompatibilitySymlinks()
    await this.rewriteMacWhisperDependencies()
    await this.resignMacWhisperRuntime()
    await rm(extractDir, { recursive: true, force: true })
  }

  private async ensureMacCompatibilitySymlinks(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const entries = await readdir(modelsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.dylib')) {
        continue
      }

      const compatibilityName = this.getMacCompatibilityDylibName(entry.name)
      if (!compatibilityName || compatibilityName === entry.name) {
        continue
      }

      await rm(join(modelsDir, compatibilityName), { force: true })
      await symlink(entry.name, join(modelsDir, compatibilityName))
    }
  }

  private getMacCompatibilityDylibName(filename: string): string | null {
    const match = /^(lib(?:whisper|ggml(?:-base)?))\.(\d+)(?:\.\d+)*\.dylib$/i.exec(filename)
    if (!match) {
      return null
    }

    const [, libraryName, majorVersion] = match
    return `${libraryName}.${majorVersion}.dylib`
  }

  private async findFileRecursive(dir: string, filename: string): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        return fullPath
      }
      if (entry.isDirectory()) {
        const found = await this.findFileRecursive(fullPath, filename)
        if (found) return found
      }
    }
    return null
  }

  private findSystemBinary(name: string): string | null {
    try {
      const cmd = IS_WIN ? `where.exe ${name}` : `which ${name}`
      const result = execSync(cmd, { encoding: 'utf-8' }).trim()
      return result.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  private getPackagedFfmpegPath(): string | null {
    if (!usesManagedRuntimeOnly()) {
      return null
    }

    return ffmpegStatic
  }

  private async resolvePackagedFfmpegPath(): Promise<string | null> {
    const packagedFfmpegPath = this.getPackagedFfmpegPath()
    if (!packagedFfmpegPath) {
      return null
    }

    if (await this.fileExists(packagedFfmpegPath)) {
      return packagedFfmpegPath
    }

    if (!IS_WIN) {
      return null
    }

    const unpackedFfmpegPath = packagedFfmpegPath.replace(
      /([\\/])app\.asar([\\/])/i,
      '$1app.asar.unpacked$2'
    )

    if (unpackedFfmpegPath !== packagedFfmpegPath && (await this.fileExists(unpackedFfmpegPath))) {
      return unpackedFfmpegPath
    }

    return null
  }

  private async installBundledBinary(source: string, dest: string): Promise<void> {
    await rm(dest, { force: true })
    await copyFile(source, dest)
    if (!IS_WIN) {
      await chmod(dest, 0o755)
    }
  }

  private async linkOrCopy(source: string, dest: string): Promise<void> {
    if (IS_WIN) {
      try {
        await rm(dest, { force: true })
        await copyFile(source, dest)
        return
      } catch (err) {
        logAutodocFailure({
          area: 'whisper',
          message: 'Failed to copy Whisper dependency into app runtime',
          error: err,
          context: { source, dest }
        })
        throw err
      }
    }

    try {
      await rm(dest, { force: true })
      await symlink(source, dest)
      return
    } catch (symlinkError) {
      try {
        await rm(dest, { force: true })
        await copyFile(source, dest)
        return
      } catch (copyError) {
        logAutodocFailure({
          area: 'whisper',
          message: 'Failed to link or copy Whisper dependency into app runtime',
          error: copyError,
          context: {
            source,
            dest,
            symlinkError:
              symlinkError instanceof Error ? symlinkError.message : String(symlinkError)
          }
        })
        throw copyError
      }
    }
  }

  private async copyWhisperBundle(sourceBinary: string, destBinary: string): Promise<void> {
    await rm(destBinary, { force: true })
    await copyFile(sourceBinary, destBinary)

    if (!IS_WIN) {
      await chmod(destBinary, 0o755)
    }

    if (!IS_WIN) {
      return
    }

    const sourceDir = dirname(sourceBinary)
    const entries = await readdir(sourceDir, { withFileTypes: true })
    const existingEntries = await readdir(this.getModelsDir(), { withFileTypes: true }).catch(
      () => []
    )

    for (const entry of existingEntries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) {
        continue
      }

      await rm(join(this.getModelsDir(), entry.name), { force: true })
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) {
        continue
      }

      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(this.getModelsDir(), entry.name)
      await copyFile(sourcePath, destPath)
    }
  }

  private async copyMatchingFiles(
    sourceDir: string,
    pattern: RegExp,
    destDir: string
  ): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) {
        continue
      }

      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(destDir, entry.name)

      await rm(destPath, { force: true })
      await copyFile(sourcePath, destPath)
      await chmod(destPath, 0o755)
    }
  }

  private getMacHomebrewBottleTag(): string {
    const systemVersion =
      typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '14.0.0'
    const majorVersion = Number(systemVersion.split('.')[0] ?? 0)
    const archPrefix = process.arch === 'arm64' ? 'arm64_' : ''

    if (majorVersion >= 16) return `${archPrefix}tahoe`
    if (majorVersion >= 15) return `${archPrefix}sequoia`
    return `${archPrefix}sonoma`
  }

  private async fetchHomebrewFormula(name: string): Promise<HomebrewFormulaResponse> {
    const response = await fetch(`${HOMEBREW_API_ROOT}/${name}.json`)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${name} metadata: ${response.status} ${response.statusText}`)
    }

    return (await response.json()) as HomebrewFormulaResponse
  }

  private getHomebrewBottleUrl(
    formula: HomebrewFormulaResponse,
    bottleTag: string,
    formulaName: string
  ): string {
    const url = formula.bottle?.stable?.files?.[bottleTag]?.url
    if (!url) {
      throw new Error(
        `AutoDoc does not have a supported ${formulaName} runtime package for this Mac.`
      )
    }

    return url
  }

  private async downloadGhcrBottle(
    url: string,
    packageName: string,
    destPath: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const scope = `repository:homebrew/core/${packageName}:pull`
    const tokenUrl = `https://ghcr.io/token?scope=${encodeURIComponent(scope)}`
    const tokenResponse = await fetch(tokenUrl)
    if (!tokenResponse.ok) {
      throw new Error(
        `Failed to authorize ${packageName} download: ${tokenResponse.status} ${tokenResponse.statusText}`
      )
    }

    const tokenPayload = (await tokenResponse.json()) as { token?: string }
    if (!tokenPayload.token) {
      throw new Error(`Failed to authorize ${packageName} download: missing token.`)
    }

    await this.downloadFile(url, destPath, packageName, onProgress, {
      headers: {
        Authorization: `Bearer ${tokenPayload.token}`
      }
    })
  }

  private async extractTarGz(archivePath: string, destDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['xzf', archivePath, '-C', destDir], (err) => {
        if (err) reject(new Error(`Failed to extract archive: ${err.message}`))
        else resolve()
      })
    })
  }

  private async rewriteMacWhisperDependencies(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const binaryPath = this.getWhisperPath()
    const entries = await readdir(modelsDir, { withFileTypes: true })
    const dylibPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.dylib'))
      .map((entry) => join(modelsDir, entry.name))
    const bundlePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.so'))
      .map((entry) => join(modelsDir, entry.name))

    for (const dylibPath of dylibPaths) {
      await this.setMacInstallName(dylibPath, `@loader_path/${basename(dylibPath)}`)
      await this.rewriteMacLoadCommands(dylibPath, '@loader_path')
    }

    for (const bundlePath of bundlePaths) {
      await this.rewriteMacLoadCommands(bundlePath, '@loader_path')
    }

    await this.rewriteMacLoadCommands(binaryPath, '@executable_path')
  }

  private async resignMacWhisperRuntime(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const entries = await readdir(modelsDir, { withFileTypes: true })
    const runtimePaths = [
      ...entries
        .filter(
          (entry) => entry.isFile() && (entry.name.endsWith('.dylib') || entry.name.endsWith('.so'))
        )
        .map((entry) => join(modelsDir, entry.name)),
      this.getWhisperPath()
    ]

    for (const runtimePath of runtimePaths) {
      await new Promise<void>((resolve, reject) => {
        execFile('codesign', ['--sign', '-', '--force', runtimePath], (err) => {
          if (err)
            reject(new Error(`Failed to re-sign macOS transcription runtime: ${err.message}`))
          else resolve()
        })
      })
    }
  }

  private async rewriteMacLoadCommands(
    filePath: string,
    localPrefix: '@loader_path' | '@executable_path'
  ): Promise<void> {
    const dependencies = await this.listMacDependencies(filePath)

    for (const dependency of dependencies) {
      const dependencyName = basename(dependency)
      if (
        !dependencyName.startsWith('libwhisper') &&
        !dependencyName.startsWith('libggml') &&
        !dependencyName.startsWith('libomp')
      ) {
        continue
      }

      await this.changeMacDependency(filePath, dependency, `${localPrefix}/${dependencyName}`)
    }
  }

  private async listMacDependencies(filePath: string): Promise<string[]> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('otool', ['-L', filePath], { encoding: 'utf8' }, (err, resultStdout) => {
        if (err) reject(new Error(`Failed to inspect macOS runtime links: ${err.message}`))
        else resolve(resultStdout)
      })
    })

    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(' ')[0])
      .filter(Boolean)
  }

  private async setMacInstallName(filePath: string, installName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('install_name_tool', ['-id', installName, filePath], (err) => {
        if (err) reject(new Error(`Failed to rewrite macOS runtime id: ${err.message}`))
        else resolve()
      })
    })
  }

  private async changeMacDependency(
    filePath: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('install_name_tool', ['-change', oldPath, newPath, filePath], (err) => {
        if (err) reject(new Error(`Failed to rewrite macOS runtime dependency: ${err.message}`))
        else resolve()
      })
    })
  }

  private async isWhisperUsable(): Promise<boolean | WhisperUsabilityResult> {
    if (
      !(await this.fileExists(this.getWhisperPath())) ||
      !(await this.fileExists(this.getModelPath()))
    ) {
      return 'missing-assets'
    }

    const probeDir = await mkdtemp(join(tmpdir(), 'autodoc-whisper-probe-'))
    const probeWavPath = join(probeDir, 'probe.wav')

    try {
      await writeFile(probeWavPath, this.createSilentProbeWav())

      return await new Promise<WhisperUsabilityResult>((resolve) => {
        execFile(
          this.getWhisperPath(),
          ['-m', this.getModelPath(), '-f', probeWavPath, '-oj', '-l', 'en', '-pp'],
          { windowsHide: true, timeout: WHISPER_PROBE_TIMEOUT_MS },
          (err, stdout, stderr) => {
            const stdoutText = typeof stdout === 'string' ? stdout : ''
            const stderrText = typeof stderr === 'string' ? stderr : ''
            if (err) {
              const usability = this.classifyWhisperProbeFailure(err, stdoutText, stderrText)
              if (usability === 'slow-validation') {
                logAutodocEvent({
                  area: 'whisper',
                  message: 'Whisper probe timed out after model load; accepting installed assets',
                  level: 'warn',
                  context: {
                    whisperPath: this.getWhisperPath(),
                    modelPath: this.getModelPath(),
                    probeTimeoutMs: WHISPER_PROBE_TIMEOUT_MS,
                    stderrTail: stderrText.slice(-1000)
                  }
                })
              } else {
                logAutodocFailure({
                  area: 'whisper',
                  message: 'Whisper probe validation failed',
                  error: err,
                  context: {
                    whisperPath: this.getWhisperPath(),
                    modelPath: this.getModelPath(),
                    stdoutTail: stdoutText.slice(-1000),
                    stderrTail: stderrText.slice(-1000),
                    probeTimeoutMs: WHISPER_PROBE_TIMEOUT_MS,
                    usability
                  }
                })
              }
              resolve(usability)
              return
            }

            resolve('ready')
          }
        )
      })
    } finally {
      await rm(probeDir, { recursive: true, force: true })
    }
  }

  private async isFasterWhisperUsable(): Promise<boolean> {
    if (!(await this.fileExists(this.getFasterWhisperPythonPath()))) {
      return false
    }
    if (!(await this.fileExists(this.getFasterWhisperModelPath()))) {
      return false
    }
    if (!(await this.fileExists(this.getFasterWhisperScriptPath()))) {
      return false
    }

    const profile = this.getSelectedWindowsProfile()
    const probeDir = await mkdtemp(join(tmpdir(), 'autodoc-faster-whisper-probe-'))
    const probeWavPath = join(probeDir, 'probe.wav')
    const probeJsonPath = join(probeDir, 'probe.json')

    try {
      await writeFile(probeWavPath, this.createSilentProbeWav())
      return await new Promise<boolean>((resolve) => {
        execFile(
          this.getFasterWhisperPythonPath(),
          [
            this.getFasterWhisperScriptPath(),
            '--model',
            this.getFasterWhisperModelPath(),
            '--audio',
            probeWavPath,
            '--output',
            probeJsonPath,
            '--device',
            profile.device,
            '--compute-type',
            profile.computeType,
            '--language',
            'en',
            '--threads',
            '2'
          ],
          { windowsHide: true, timeout: FASTER_WHISPER_PROBE_TIMEOUT_MS },
          (err, stdout, stderr) => {
            if (err) {
              logAutodocFailure({
                area: 'whisper',
                message: 'Faster Whisper probe validation failed',
                error: err,
                context: {
                  backend: profile.id,
                  backendLabel: profile.label,
                  pythonPath: this.getFasterWhisperPythonPath(),
                  modelPath: this.getFasterWhisperModelPath(),
                  stdoutTail: String(stdout ?? '').slice(-1000),
                  stderrTail: String(stderr ?? '').slice(-1000)
                }
              })
              resolve(false)
              return
            }

            resolve(true)
          }
        )
      })
    } finally {
      await rm(probeDir, { recursive: true, force: true })
    }
  }

  private async isFasterWhisperUsableWithRetry(): Promise<boolean> {
    if (await this.isFasterWhisperUsable()) {
      return true
    }

    for (const delayMs of WHISPER_PROBE_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (await this.isFasterWhisperUsable()) {
        return true
      }
    }

    return false
  }

  private async isWhisperUsableWithRetry(): Promise<WhisperUsabilityResult> {
    const initialResult = this.normalizeWhisperUsabilityResult(await this.isWhisperUsable())
    if (this.isWhisperUsabilityAccepted(initialResult)) {
      return initialResult
    }

    for (const delayMs of WHISPER_PROBE_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      const retryResult = this.normalizeWhisperUsabilityResult(await this.isWhisperUsable())
      if (this.isWhisperUsabilityAccepted(retryResult)) {
        return retryResult
      }
    }

    return initialResult
  }

  private normalizeWhisperUsabilityResult(
    result: boolean | WhisperUsabilityResult
  ): WhisperUsabilityResult {
    if (result === true) return 'ready'
    if (result === false) return 'failed'
    return result
  }

  private isWhisperUsabilityAccepted(result: WhisperUsabilityResult): boolean {
    return result === 'ready' || result === 'slow-validation'
  }

  private classifyWhisperProbeFailure(
    err: Error & { killed?: boolean; signal?: string | null; code?: string | number | null },
    stdout: string,
    stderr: string
  ): WhisperUsabilityResult {
    const combinedOutput = `${stdout}\n${stderr}`
    const timedOut =
      err.killed === true ||
      err.code === 'ETIMEDOUT' ||
      /timed out|timeout/i.test(err.message) ||
      (err.signal === 'SIGTERM' && /processing|whisper_model_load/i.test(combinedOutput))
    const modelLoaded =
      /whisper_model_load:\s+model size/i.test(combinedOutput) ||
      /main:\s+processing/i.test(combinedOutput)

    if (timedOut && (modelLoaded || !IS_WIN)) {
      return 'slow-validation'
    }

    return 'failed'
  }

  private createSilentProbeWav(): Buffer {
    const sampleRate = 16_000
    const channels = 1
    const bitsPerSample = 16
    const durationSeconds = 1
    const blockAlign = (channels * bitsPerSample) / 8
    const byteRate = sampleRate * blockAlign
    const dataSize = sampleRate * durationSeconds * blockAlign
    const wav = Buffer.alloc(44 + dataSize)

    wav.write('RIFF', 0, 'ascii')
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8, 'ascii')
    wav.write('fmt ', 12, 'ascii')
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(channels, 22)
    wav.writeUInt32LE(sampleRate, 24)
    wav.writeUInt32LE(byteRate, 28)
    wav.writeUInt16LE(blockAlign, 32)
    wav.writeUInt16LE(bitsPerSample, 34)
    wav.write('data', 36, 'ascii')
    wav.writeUInt32LE(dataSize, 40)

    return wav
  }

  private getFailedStep(): WhisperSetupStatus['failedStep'] {
    switch (this.setupStatus.phase) {
      case 'downloading-whisper':
        return 'downloading-whisper'
      case 'downloading-ffmpeg':
        return 'downloading-ffmpeg'
      case 'downloading-model':
        return 'downloading-model'
      default:
        return 'ready'
    }
  }

  private async downloadWithRetry(
    fn: () => Promise<void>,
    _label: string,
    attempts = 3
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await fn()
        return
      } catch (err) {
        if (i === attempts - 1) throw err
        const delay = Math.pow(2, i) * 1000
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async copyIfMissing(source: string, destination: string): Promise<void> {
    if (await this.fileExists(destination)) {
      return
    }
    if (!(await this.fileExists(source))) {
      return
    }

    await copyFile(source, destination)
    if (!IS_WIN) {
      await chmod(destination, 0o755)
    }
  }

  private async downloadModel(): Promise<void> {
    const model = this.getModelInfo()
    await this.downloadFile(model.downloadUrl, this.getModelPath(), model.filename, (p) => {
      this.setupStatus = this.withBackendStatus({ phase: 'downloading-model', percent: p })
      this.emit('setup-status', this.getSetupStatus())
    })
  }

  private async closeFileStream(fileStream: ReturnType<typeof createWriteStream>): Promise<void> {
    if (fileStream.writableFinished || fileStream.destroyed) {
      return
    }

    const finished = new Promise<void>((resolve, reject) => {
      fileStream.once('finish', resolve)
      fileStream.once('error', reject)
    })
    fileStream.end()
    await finished
  }

  private async downloadFile(
    url: string,
    destPath: string,
    label: string,
    onProgress?: (percent: number) => void,
    init?: RequestInit
  ): Promise<void> {
    const response = await fetch(url, { redirect: 'follow', ...init })
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0
    const tempPath = `${destPath}.tmp`

    await rm(tempPath, { force: true })
    const fileStream = createWriteStream(tempPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`No response body for ${label}`)

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(value)) {
          await once(fileStream, 'drain')
        }
        downloadedBytes += value.length
        const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0
        onProgress?.(percent)
        this.emit('download-progress', {
          file: label,
          percent,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes
        } as DownloadProgress)
      }

      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })

      if (totalBytes > 0 && downloadedBytes !== totalBytes) {
        throw new Error(
          `Downloaded ${label} was incomplete: expected ${totalBytes} bytes, received ${downloadedBytes}.`
        )
      }

      await rm(destPath, { force: true })
      await rename(tempPath, destPath)
    } catch (err) {
      await this.closeFileStream(fileStream)
      await rm(tempPath, { force: true })
      throw err
    }
  }
}
