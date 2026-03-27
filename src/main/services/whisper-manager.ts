import { app } from 'electron'
import { access, mkdir, copyFile, rm, readdir, symlink } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { execFile, execSync } from 'child_process'
import { EventEmitter } from 'events'
import { MODELS_SUBDIR } from '../../shared/constants'
import type { WhisperSetupStatus } from '../../shared/types'

const IS_WIN = process.platform === 'win32'

// Pinned release versions for reproducibility
const WHISPER_VERSION = 'v1.8.4'
const WHISPER_WIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
const FFMPEG_WIN_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip'

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

export class WhisperManager extends EventEmitter {
  private setupPromise: Promise<void> | null = null
  private setupStatus: WhisperSetupStatus = { phase: 'downloading-whisper', percent: 0 }

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
    return join(this.getModelsDir(), 'ggml-large-v3.bin')
  }

  getSetupStatus(): WhisperSetupStatus {
    return { ...this.setupStatus }
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getWhisperPath())
      await access(this.getModelPath())
      await access(this.getFfmpegPath())
      return true
    } catch {
      return false
    }
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startSetup(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = this.runSetup().catch((err) => {
        this.setupPromise = null
        throw err
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
    await mkdir(this.getModelsDir(), { recursive: true })

    if (!(await this.fileExists(this.getWhisperPath()))) {
      this.setupStatus = { phase: 'downloading-whisper', percent: 0 }
      this.emit('setup-status', this.getSetupStatus())
      await this.resolveWhisper()
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
  }

  private async resolveWhisper(): Promise<void> {
    const binaryName = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli'
    const systemPath = this.findSystemBinary(binaryName)
    if (systemPath) {
      await this.linkOrCopy(systemPath, this.getWhisperPath())
      return
    }
    if (IS_WIN) {
      await this.downloadWhisperWindows()
      return
    }
    throw new Error(
      'whisper-cli not found. Install it with: brew install whisper-cpp',
    )
  }

  private async resolveFfmpeg(): Promise<void> {
    const binaryName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
    const systemPath = this.findSystemBinary(binaryName)
    if (systemPath) {
      await this.linkOrCopy(systemPath, this.getFfmpegPath())
      return
    }
    if (IS_WIN) {
      await this.downloadFfmpegWindows()
      return
    }
    throw new Error(
      'ffmpeg not found. Install it with: brew install ffmpeg',
    )
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
    const whisperExe = await this.findFileRecursive(extractDir, 'whisper-cli.exe')
    if (!whisperExe) {
      // Fallback: look for main.exe (older whisper.cpp naming)
      const mainExe = await this.findFileRecursive(extractDir, 'main.exe')
      if (mainExe) {
        await copyFile(mainExe, this.getWhisperPath())
      } else {
        throw new Error('whisper-cli.exe not found in downloaded archive')
      }
    } else {
      await copyFile(whisperExe, this.getWhisperPath())
    }

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
    await rm(zipPath, { force: true })
    await rm(extractDir, { recursive: true, force: true })
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

  private async linkOrCopy(source: string, dest: string): Promise<void> {
    if (IS_WIN) {
      await copyFile(source, dest).catch(() => {})
    } else {
      await symlink(source, dest).catch(() => {})
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
    const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
    await this.downloadFile(url, this.getModelPath(), 'ggml-large-v3.bin', (p) => {
      this.setupStatus = { phase: 'downloading-model', percent: p }
      this.emit('setup-status', this.getSetupStatus())
    })
  }

  private async downloadFile(
    url: string,
    destPath: string,
    label: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' })
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
