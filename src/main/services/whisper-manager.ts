import { app } from 'electron'
import { access, mkdir, chmod, symlink, unlink } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { execSync } from 'child_process'
import { EventEmitter } from 'events'
import { MODELS_SUBDIR } from '../../shared/constants'

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
    return join(this.getModelsDir(), 'whisper-cpp')
  }

  getFfmpegPath(): string {
    return join(this.getModelsDir(), 'ffmpeg')
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
    // Homebrew installs whisper.cpp as 'whisper-cli'
    const systemPath = this.findSystemBinary('whisper-cli')
    if (systemPath) {
      await symlink(systemPath, this.getWhisperPath()).catch(() => {})
      return
    }
    throw new Error(
      'whisper-cli not found. Install it with: brew install whisper-cpp'
    )
  }

  private async resolveFfmpeg(): Promise<void> {
    const systemPath = this.findSystemBinary('ffmpeg')
    if (systemPath) {
      await symlink(systemPath, this.getFfmpegPath()).catch(() => {})
      return
    }
    throw new Error(
      'ffmpeg not found. Install it with: brew install ffmpeg'
    )
  }

  private findSystemBinary(name: string): string | null {
    try {
      return execSync(`which ${name}`, { encoding: 'utf-8' }).trim()
    } catch {
      return null
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
