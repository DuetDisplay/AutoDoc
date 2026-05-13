import { app } from 'electron'
import { createHash } from 'crypto'
import {
  access,
  mkdir,
  cp,
  copyFile,
  rm,
  readdir,
  symlink,
  chmod,
  mkdtemp,
  writeFile,
  rename,
  stat
} from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createReadStream, createWriteStream, existsSync } from 'fs'
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
const MAC_WHISPER_RUNTIME_RELEASE_TAG =
  process.env.AUTODOC_MACOS_WHISPER_RUNTIME_RELEASE_TAG ?? 'macos-whisper-runtime-v1'
const MAC_WHISPER_RUNTIME_ASSET_BASE_URL =
  process.env.AUTODOC_MACOS_WHISPER_RUNTIME_ASSET_BASE_URL ??
  `https://github.com/DuetDisplay/AutoDoc-Local/releases/download/${MAC_WHISPER_RUNTIME_RELEASE_TAG}`
const MAC_WHISPER_RUNTIME_EXPECTED_FILES = [
  'whisper-cpp',
  'libwhisper.1.dylib',
  'libggml.0.dylib',
  'libggml-base.0.dylib'
]

type WhisperUsabilityResult =
  | 'ready'
  | 'missing-assets'
  | 'slow-validation'
  | 'runtime-link-failure'
  | 'failed'

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

interface MacWhisperRuntimeAsset {
  filename: string
  url: string
  sha256: string
  bytes?: number
  expectedFiles: string[]
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
    return this.getDevelopmentResourcePath('faster-whisper-transcribe.py')
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

  async installBundledMacWhisperRuntimeOnly(): Promise<void> {
    if (IS_WIN) {
      throw new Error('Bundled macOS Whisper runtime install is not available on Windows.')
    }

    const bundledRuntimeDir = await this.resolveBundledMacWhisperRuntimeDir()
    if (!bundledRuntimeDir) {
      throw new Error('Bundled macOS Whisper runtime is missing from this app package.')
    }

    await this.installMacWhisperRuntimeFromDir(bundledRuntimeDir)
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
    const manifestPath = this.getWindowsTranscriptionManifestPath()
    this.windowsTranscriptionProfiles = await loadWindowsTranscriptionProfiles(manifestPath)
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
        manifestPath,
        manifestPresent: await this.fileExists(manifestPath),
        assets: this.selectedWindowsProfile.assets.map((asset) => ({
          id: asset.id,
          filename: asset.filename,
          url: asset.url,
          expectedBytes: asset.bytes,
          expectedSha256: asset.sha256,
          expectedFiles: asset.expectedFiles
        })),
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

    return this.getDevelopmentResourcePath('windows-transcription-manifest.json')
  }

  private getDevelopmentAppPath(): string {
    return typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  }

  private getDevelopmentResourcePath(filename: string): string {
    const appResourcePath = join(this.getDevelopmentAppPath(), 'resources', filename)
    if (existsSync(appResourcePath)) {
      return appResourcePath
    }

    return join(process.cwd(), 'resources', filename)
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

      if (usability === 'runtime-link-failure') {
        await this.recoverFromRuntimeValidationFailure()
        usability = await this.isWhisperUsableWithRetry()
      }

      if (!this.isWhisperUsabilityAccepted(usability) && usability !== 'runtime-link-failure') {
        await this.recoverFromProbeValidationFailure()
        usability = await this.isWhisperUsableWithRetry()
      }

      if (usability === 'runtime-link-failure') {
        await this.recoverFromRuntimeValidationFailure()
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
      const missingExpectedFiles = await this.getMissingExpectedFiles(
        assetRoot,
        asset.expectedFiles
      )
      if (missingExpectedFiles.length === 0) {
        logAutodocEvent({
          area: 'whisper',
          message: 'Windows transcription asset already present',
          context: {
            backend: profile.id,
            assetId: asset.id,
            filename: asset.filename,
            targetDir: assetRoot
          }
        })
        continue
      }

      logAutodocEvent({
        area: 'whisper',
        message: 'Windows transcription asset missing expected files before download',
        context: {
          backend: profile.id,
          assetId: asset.id,
          filename: asset.filename,
          targetDir: assetRoot,
          missingExpectedFiles
        }
      })
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

    logAutodocEvent({
      area: 'whisper',
      message: 'Windows transcription asset download started',
      context: {
        backend: profile.id,
        assetId: asset.id,
        filename: asset.filename,
        url: asset.url,
        expectedBytes: asset.bytes,
        expectedSha256: asset.sha256,
        archivePath,
        targetDir
      }
    })
    await mkdir(targetDir, { recursive: true })
    await this.downloadFile(asset.url, archivePath, asset.filename, (p) => {
      this.setupStatus = this.withBackendStatus({
        phase: asset.id === 'runtime' ? 'downloading-whisper' : 'downloading-model',
        percent: p
      })
      this.emit('setup-status', this.getSetupStatus())
    })
    const actualSha256 = await this.verifyFileSha256(archivePath, asset.sha256, asset.filename)
    const archiveStats = await stat(archivePath)
    logAutodocEvent({
      area: 'whisper',
      message: 'Windows transcription asset download verified',
      context: {
        backend: profile.id,
        assetId: asset.id,
        filename: asset.filename,
        expectedBytes: asset.bytes,
        actualBytes: archiveStats.size,
        expectedSha256: asset.sha256,
        actualSha256
      }
    })

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
    const missingExpectedFiles = await this.getMissingExpectedFiles(targetDir, asset.expectedFiles)
    logAutodocEvent({
      area: 'whisper',
      message: 'Windows transcription asset extracted',
      context: {
        backend: profile.id,
        assetId: asset.id,
        filename: asset.filename,
        targetDir,
        expectedFiles: asset.expectedFiles,
        missingExpectedFiles
      }
    })
  }

  private async getMissingExpectedFiles(
    rootDir: string,
    expectedFiles: string[]
  ): Promise<string[]> {
    const missingExpectedFiles: string[] = []
    for (const expectedFile of expectedFiles) {
      if (!(await this.fileExists(join(rootDir, ...expectedFile.split('/'))))) {
        missingExpectedFiles.push(expectedFile)
      }
    }

    return missingExpectedFiles
  }

  private async verifyFileSha256(
    filePath: string,
    expectedSha256: string,
    label: string
  ): Promise<string> {
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
    return actualSha256
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

  private async recoverFromRuntimeValidationFailure(): Promise<void> {
    this.setupStatus = this.withBackendStatus({ phase: 'downloading-whisper', percent: 0 })
    this.emit('setup-status', this.getSetupStatus())

    logAutodocEvent({
      area: 'whisper',
      message: 'Whisper runtime validation failed; reinstalling managed runtime',
      context: {
        diagnostics: await getStorageDiagnostics({
          whisperModelPath: this.getModelPath(),
          whisperBinaryPath: this.getWhisperPath(),
          ffmpegPath: this.getFfmpegPath()
        })
      }
    })

    if (!IS_WIN) {
      await this.removeMacWhisperRuntimeFiles()
    } else {
      await rm(this.getWhisperPath(), { force: true })
    }

    await this.resolveWhisper()
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
    const bundledRuntimeDir = await this.resolveBundledMacWhisperRuntimeDir()
    if (bundledRuntimeDir) {
      await this.installMacWhisperRuntimeFromDir(bundledRuntimeDir)
      return
    }

    await this.downloadAndExtractMacWhisperRuntimeAsset(this.getMacWhisperRuntimeAsset())
  }

  private getMacWhisperRuntimeAsset(): MacWhisperRuntimeAsset {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const filename = `macos-whisper-runtime-${arch}.tar.gz`
    const shaEnvName =
      arch === 'arm64'
        ? 'AUTODOC_MACOS_WHISPER_RUNTIME_ARM64_SHA256'
        : 'AUTODOC_MACOS_WHISPER_RUNTIME_X64_SHA256'
    const bytesEnvName =
      arch === 'arm64'
        ? 'AUTODOC_MACOS_WHISPER_RUNTIME_ARM64_BYTES'
        : 'AUTODOC_MACOS_WHISPER_RUNTIME_X64_BYTES'
    const bytes = Number(process.env[bytesEnvName] ?? 0)

    return {
      filename,
      url: `${MAC_WHISPER_RUNTIME_ASSET_BASE_URL.replace(/\/$/, '')}/${filename}`,
      sha256: process.env[shaEnvName] ?? '',
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined,
      expectedFiles: MAC_WHISPER_RUNTIME_EXPECTED_FILES
    }
  }

  private async resolveBundledMacWhisperRuntimeDir(): Promise<string | null> {
    if (!app.isPackaged) {
      return null
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const candidates = [
      process.resourcesPath ? join(process.resourcesPath, 'macos-whisper-runtime', arch) : null,
      join(this.getDevelopmentAppPath(), 'resources', 'macos-whisper-runtime', arch)
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      if (
        (await this.getMissingExpectedFiles(candidate, MAC_WHISPER_RUNTIME_EXPECTED_FILES))
          .length === 0
      ) {
        return candidate
      }
    }

    return null
  }

  private async downloadAndExtractMacWhisperRuntimeAsset(
    asset: MacWhisperRuntimeAsset
  ): Promise<void> {
    const modelsDir = this.getModelsDir()
    const archivePath = join(modelsDir, asset.filename)
    const extractDir = join(modelsDir, '_whisper_extract')

    if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
      throw new Error(
        'AutoDoc is missing the checksum for its macOS local speech engine runtime package.'
      )
    }

    logAutodocEvent({
      area: 'whisper',
      message: 'macOS Whisper runtime download started',
      context: {
        filename: asset.filename,
        url: asset.url,
        expectedBytes: asset.bytes,
        expectedSha256: asset.sha256,
        archivePath,
        extractDir
      }
    })

    await mkdir(modelsDir, { recursive: true })
    await this.downloadFile(asset.url, archivePath, asset.filename, (p) => {
      this.setupStatus = this.withBackendStatus({ phase: 'downloading-whisper', percent: p })
      this.emit('setup-status', this.getSetupStatus())
    })
    const actualSha256 = await this.verifyFileSha256(archivePath, asset.sha256, asset.filename)
    const archiveStats = await stat(archivePath)

    logAutodocEvent({
      area: 'whisper',
      message: 'macOS Whisper runtime download verified',
      context: {
        filename: asset.filename,
        expectedBytes: asset.bytes,
        actualBytes: archiveStats.size,
        expectedSha256: asset.sha256,
        actualSha256
      }
    })

    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    await this.extractTarGz(archivePath, extractDir)

    const runtimeRoot = await this.findMacWhisperRuntimeRoot(extractDir, asset.expectedFiles)
    if (!runtimeRoot) {
      await rm(archivePath, { force: true })
      await rm(extractDir, { recursive: true, force: true })
      throw new Error('AutoDoc could not unpack the macOS local speech engine runtime package.')
    }

    await this.installMacWhisperRuntimeFromDir(runtimeRoot)
    await rm(archivePath, { force: true })
    await rm(extractDir, { recursive: true, force: true })
  }

  private async findMacWhisperRuntimeRoot(
    extractDir: string,
    expectedFiles: string[]
  ): Promise<string | null> {
    if ((await this.getMissingExpectedFiles(extractDir, expectedFiles)).length === 0) {
      return extractDir
    }

    const entries = await readdir(extractDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const candidate = join(extractDir, entry.name)
      if ((await this.getMissingExpectedFiles(candidate, expectedFiles)).length === 0) {
        return candidate
      }
    }

    return null
  }

  private async installMacWhisperRuntimeFromDir(sourceDir: string): Promise<void> {
    const modelsDir = this.getModelsDir()
    const extractDir = join(modelsDir, '_whisper_extract')
    const preserveExtractDir = sourceDir === extractDir || sourceDir.startsWith(`${extractDir}/`)
    await mkdir(modelsDir, { recursive: true })
    await this.removeMacWhisperRuntimeFiles({ preserveExtractDir })

    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('._')) {
        continue
      }

      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(modelsDir, entry.name)
      await cp(sourcePath, destPath, { recursive: true, force: true })
    }

    await this.chmodMacWhisperRuntimeFiles()
  }

  private async chmodMacWhisperRuntimeFiles(): Promise<void> {
    const entries = await readdir(this.getModelsDir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !this.isMacWhisperRuntimeFile(entry.name)) {
        continue
      }
      await chmod(join(this.getModelsDir(), entry.name), 0o755)
    }
  }

  private async removeMacWhisperRuntimeFiles(options?: {
    preserveExtractDir?: boolean
  }): Promise<void> {
    const modelsDir = this.getModelsDir()
    const entries = await readdir(modelsDir, { withFileTypes: true }).catch(() => [])

    if (!options?.preserveExtractDir) {
      await rm(join(modelsDir, '_whisper_extract'), { recursive: true, force: true })
    }

    for (const entry of entries) {
      if (!this.isMacWhisperRuntimeFile(entry.name)) {
        continue
      }

      await rm(join(modelsDir, entry.name), {
        recursive: entry.isDirectory(),
        force: true
      })
    }
  }

  private isMacWhisperRuntimeFile(filename: string): boolean {
    return (
      filename === basename(this.getWhisperPath()) ||
      /^libwhisper.*\.(?:dylib|so)$/i.test(filename) ||
      /^libggml.*\.(?:dylib|so)$/i.test(filename) ||
      /^libomp.*\.(?:dylib|so)$/i.test(filename)
    )
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

  private async extractTarGz(archivePath: string, destDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['xzf', archivePath, '-C', destDir], (err) => {
        if (err) reject(new Error(`Failed to extract archive: ${err.message}`))
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
    const macRuntimeLinkFailure =
      !IS_WIN &&
      (/dyld\[\d+\]:\s+Library not loaded:\s+@rpath\/lib(?:whisper|ggml|omp)/i.test(
        combinedOutput
      ) ||
        /Library not loaded:\s+@rpath\/lib(?:whisper|ggml|omp)/i.test(combinedOutput) ||
        /install_name_tool|Failed to rewrite macOS runtime|No developer tools were found/i.test(
          `${err.message}\n${combinedOutput}`
        ))

    if (macRuntimeLinkFailure) {
      return 'runtime-link-failure'
    }

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
