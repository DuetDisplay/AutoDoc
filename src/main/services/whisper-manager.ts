import { app } from 'electron'
import { access, mkdir, copyFile, rm, readdir, symlink, chmod } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { createWriteStream } from 'fs'
import { execFile, execSync } from 'child_process'
import { EventEmitter } from 'events'
import ffmpegStatic from 'ffmpeg-static'
import { MODELS_SUBDIR } from '../../shared/constants'
import type { WhisperSetupStatus } from '../../shared/types'
import { logAutodocFailure } from './autodoc-log'
import { canUseSystemRuntimeFallback, usesManagedRuntimeOnly } from './runtime-policy'

const IS_WIN = process.platform === 'win32'

// Pinned release versions for reproducibility
const WHISPER_VERSION = 'v1.8.4'
const WHISPER_WIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
const FFMPEG_WIN_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'
const WHISPER_PROBE_TIMEOUT_MS = 30_000
const HOMEBREW_API_ROOT = 'https://formulae.brew.sh/api/formula'
const MAC_WHISPER_FORMULA = 'whisper-cpp'
const MAC_GGML_FORMULA = 'ggml'

const DEFAULT_MODEL = IS_WIN
  ? {
      filename: 'ggml-distil-large-v3.bin',
      downloadUrl: 'https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin',
    }
  : {
      filename: 'ggml-large-v3.bin',
      downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
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
    return this.getModelInfo().filename.replace(/^ggml-/, '').replace(/\.bin$/i, '')
  }

  getSetupStatus(): WhisperSetupStatus {
    return { ...this.setupStatus }
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getModelPath())
      await access(this.getFfmpegPath())
      return await this.isWhisperUsable()
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
      this.setupStatus = { phase: 'ready', percent: 100 }
      this.emit('setup-status', this.getSetupStatus())
    } catch (err) {
      this.setupStatus = {
        phase: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : String(err),
      }
      this.emit('setup-status', this.getSetupStatus())
      throw err
    }
  }

  async ensureReady(): Promise<void> {
    try {
      await mkdir(this.getModelsDir(), { recursive: true })

      if (!(await this.isWhisperUsable())) {
        this.setupStatus = { phase: 'downloading-whisper', percent: 0 }
        this.emit('setup-status', this.getSetupStatus())
        await this.resolveWhisper()
        if (!(await this.isWhisperUsable())) {
          throw new Error(
            IS_WIN
              ? 'whisper-cli failed startup validation after setup. Required Windows runtime files may be missing.'
              : 'whisper-cli failed startup validation after setup.',
          )
        }
      }
      if (!(await this.fileExists(this.getFfmpegPath()))) {
        this.setupStatus = { phase: 'downloading-ffmpeg', percent: 0 }
        this.emit('setup-status', this.getSetupStatus())
        await this.resolveFfmpeg()
      }
      if (!(await this.fileExists(this.getModelPath()))) {
        this.setupStatus = { phase: 'downloading-model', percent: 0 }
        this.emit('setup-status', this.getSetupStatus())
        await this.downloadWithRetry(() => this.downloadModel(), 'model')
      }

      this.setupStatus = { phase: 'ready', percent: 100 }
      this.emit('setup-status', this.getSetupStatus())
    } catch (err) {
      this.setupStatus = {
        phase: 'error',
        percent: 0,
        error: err instanceof Error ? err.message : String(err),
        failedStep: this.getFailedStep(),
      }
      this.emit('setup-status', this.getSetupStatus())
      throw err
    }
  }

  private async resolveWhisper(): Promise<void> {
    const binaryName = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli'
    if (canUseSystemRuntimeFallback()) {
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
    const packagedFfmpegPath = this.getPackagedFfmpegPath()
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

    if (IS_WIN && !usesManagedRuntimeOnly()) {
      await this.downloadFfmpegWindows()
      return
    }

    throw new Error('AutoDoc could not finish setting up its audio tools. Please reinstall AutoDoc and try again.')
  }

  private async downloadWhisperWindows(): Promise<void> {
    const modelsDir = this.getModelsDir()
    const zipPath = join(modelsDir, 'whisper.zip')

    await this.downloadFile(WHISPER_WIN_URL, zipPath, 'whisper-cli', (p) => {
      this.setupStatus = { phase: 'downloading-whisper', percent: p }
      this.emit('setup-status', this.getSetupStatus())
    })

    const extractDir = join(modelsDir, '_whisper_extract')
    await mkdir(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'`],
        (err) => {
          if (err) reject(new Error(`Failed to extract whisper: ${err.message}`))
          else resolve()
        },
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
      this.setupStatus = { phase: 'downloading-ffmpeg', percent: p }
      this.emit('setup-status', this.getSetupStatus())
    })

    const extractDir = join(modelsDir, '_ffmpeg_extract')
    await mkdir(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'`],
        (err) => {
          if (err) reject(new Error(`Failed to extract ffmpeg: ${err.message}`))
          else resolve()
        },
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
    const whisperUrl = this.getHomebrewBottleUrl(whisperFormula, bottleTag, MAC_WHISPER_FORMULA)
    const ggmlUrl = this.getHomebrewBottleUrl(ggmlFormula, bottleTag, MAC_GGML_FORMULA)
    const whisperArchivePath = join(extractDir, 'whisper-cpp.tar.gz')
    const ggmlArchivePath = join(extractDir, 'ggml.tar.gz')

    await this.downloadGhcrBottle(whisperUrl, MAC_WHISPER_FORMULA, whisperArchivePath, (p) => {
      this.setupStatus = { phase: 'downloading-whisper', percent: Math.round(p / 2) }
      this.emit('setup-status', this.getSetupStatus())
    })
    await this.extractTarGz(whisperArchivePath, extractDir)

    await this.downloadGhcrBottle(ggmlUrl, MAC_GGML_FORMULA, ggmlArchivePath, (p) => {
      this.setupStatus = { phase: 'downloading-whisper', percent: 50 + Math.round(p / 2) }
      this.emit('setup-status', this.getSetupStatus())
    })
    await this.extractTarGz(ggmlArchivePath, extractDir)

    const whisperCli = await this.findFileRecursive(extractDir, 'whisper-cli')
    if (!whisperCli) {
      throw new Error('AutoDoc could not unpack the transcription runtime for macOS.')
    }

    await copyFile(whisperCli, this.getWhisperPath())
    await chmod(this.getWhisperPath(), 0o755)

    await this.copyMatchingFiles(
      join(extractDir, MAC_WHISPER_FORMULA, whisperFormula.versions?.stable ?? WHISPER_VERSION.replace(/^v/, ''), 'lib'),
      /^libwhisper.*\.dylib$/i,
      modelsDir,
    )
    await this.copyMatchingFiles(
      join(extractDir, MAC_GGML_FORMULA, ggmlFormula.versions?.stable ?? '', 'lib'),
      /^libggml.*\.dylib$/i,
      modelsDir,
    )

    await this.ensureMacCompatibilitySymlinks()
    await this.rewriteMacWhisperDependencies()
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
          context: { source, dest },
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
            symlinkError: symlinkError instanceof Error ? symlinkError.message : String(symlinkError),
          },
        })
        throw copyError
      }
    }
  }

  private async copyWhisperBundle(sourceBinary: string, destBinary: string): Promise<void> {
    await copyFile(sourceBinary, destBinary)

    if (!IS_WIN) {
      return
    }

    const sourceDir = dirname(sourceBinary)
    const entries = await readdir(sourceDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.dll')) {
        continue
      }

      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(this.getModelsDir(), entry.name)
      await copyFile(sourcePath, destPath)
    }
  }

  private async copyMatchingFiles(sourceDir: string, pattern: RegExp, destDir: string): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) {
        continue
      }

      await copyFile(join(sourceDir, entry.name), join(destDir, entry.name))
    }
  }

  private getMacHomebrewBottleTag(): string {
    const majorVersion = Number(process.getSystemVersion().split('.')[0] ?? 0)
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

  private getHomebrewBottleUrl(formula: HomebrewFormulaResponse, bottleTag: string, formulaName: string): string {
    const url = formula.bottle?.stable?.files?.[bottleTag]?.url
    if (!url) {
      throw new Error(`AutoDoc does not have a supported ${formulaName} runtime package for this Mac.`)
    }

    return url
  }

  private async downloadGhcrBottle(
    url: string,
    packageName: string,
    destPath: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const scope = `repository:homebrew/core/${packageName}:pull`
    const tokenUrl = `https://ghcr.io/token?scope=${encodeURIComponent(scope)}`
    const tokenResponse = await fetch(tokenUrl)
    if (!tokenResponse.ok) {
      throw new Error(`Failed to authorize ${packageName} download: ${tokenResponse.status} ${tokenResponse.statusText}`)
    }

    const tokenPayload = (await tokenResponse.json()) as { token?: string }
    if (!tokenPayload.token) {
      throw new Error(`Failed to authorize ${packageName} download: missing token.`)
    }

    await this.downloadFile(url, destPath, packageName, onProgress, {
      headers: {
        Authorization: `Bearer ${tokenPayload.token}`,
      },
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

    for (const dylibPath of dylibPaths) {
      await this.setMacInstallName(dylibPath, `@loader_path/${basename(dylibPath)}`)
      await this.rewriteMacLoadCommands(dylibPath, '@loader_path')
    }

    await this.rewriteMacLoadCommands(binaryPath, '@executable_path')
  }

  private async rewriteMacLoadCommands(filePath: string, localPrefix: '@loader_path' | '@executable_path'): Promise<void> {
    const dependencies = await this.listMacDependencies(filePath)

    for (const dependency of dependencies) {
      const dependencyName = basename(dependency)
      if (!dependencyName.startsWith('libwhisper') && !dependencyName.startsWith('libggml')) {
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

  private async changeMacDependency(filePath: string, oldPath: string, newPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('install_name_tool', ['-change', oldPath, newPath, filePath], (err) => {
        if (err) reject(new Error(`Failed to rewrite macOS runtime dependency: ${err.message}`))
        else resolve()
      })
    })
  }

  private async isWhisperUsable(): Promise<boolean> {
    if (!(await this.fileExists(this.getWhisperPath()))) {
      return false
    }

    return await new Promise<boolean>((resolve) => {
      execFile(
        this.getWhisperPath(),
        ['-ng', '--help'],
        { windowsHide: true, timeout: WHISPER_PROBE_TIMEOUT_MS },
        (err) => resolve(!err),
      )
    })
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


  private async downloadWithRetry(fn: () => Promise<void>, _label: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await fn()
        return
      } catch (err) {
        if (i === attempts - 1) throw err
        const delay = Math.pow(2, i) * 1000
        await new Promise(resolve => setTimeout(resolve, delay))
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

  private async downloadModel(): Promise<void> {
    const model = this.getModelInfo()
    await this.downloadFile(model.downloadUrl, this.getModelPath(), model.filename, (p) => {
      this.setupStatus = { phase: 'downloading-model', percent: p }
      this.emit('setup-status', this.getSetupStatus())
    })
  }

  private async downloadFile(
    url: string,
    destPath: string,
    label: string,
    onProgress?: (percent: number) => void,
    init?: RequestInit,
  ): Promise<void> {
    const response = await fetch(url, { redirect: 'follow', ...init })
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0

    const fileStream = createWriteStream(destPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`No response body for ${label}`)

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fileStream.write(value)
        downloadedBytes += value.length
        const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0
        onProgress?.(percent)
        this.emit('download-progress', {
          file: label,
          percent,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes,
        } as DownloadProgress)
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }
  }
}
