import { app } from 'electron'
import { access, mkdir, chmod, symlink, unlink, copyFile } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { execSync } from 'child_process'
import { EventEmitter } from 'events'
import { MODELS_SUBDIR } from '../../shared/constants'

const IS_WIN = process.platform === 'win32'

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

export class WhisperManager extends EventEmitter {
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

  async ensureReady(): Promise<void> {
    await mkdir(this.getModelsDir(), { recursive: true })

    if (!(await this.fileExists(this.getWhisperPath()))) {
      await this.resolveWhisper()
    }
    if (!(await this.fileExists(this.getFfmpegPath()))) {
      await this.resolveFfmpeg()
    }
    if (!(await this.fileExists(this.getModelPath()))) {
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
    throw new Error(
      IS_WIN
        ? 'whisper-cli not found. Download whisper.cpp for Windows and ensure whisper-cli.exe is on your PATH.'
        : 'whisper-cli not found. Install it with: brew install whisper-cpp',
    )
  }

  private async resolveFfmpeg(): Promise<void> {
    const binaryName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
    const systemPath = this.findSystemBinary(binaryName)
    if (systemPath) {
      await this.linkOrCopy(systemPath, this.getFfmpegPath())
      return
    }
    throw new Error(
      IS_WIN
        ? 'ffmpeg not found. Download ffmpeg for Windows and ensure ffmpeg.exe is on your PATH.'
        : 'ffmpeg not found. Install it with: brew install ffmpeg',
    )
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

  private async downloadWithRetry(fn: () => Promise<void>, label: string, attempts = 3): Promise<void> {
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
    await this.downloadFile(url, this.getModelPath(), 'ggml-large-v3.bin')
  }

  private async downloadFile(url: string, destPath: string, label: string): Promise<void> {
    const response = await fetch(url)
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
        this.emit('download-progress', {
          file: label,
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
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
