import { app } from 'electron'
import { access, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { EventEmitter } from 'events'
import { RECORDING_DIR_NAME, MODELS_SUBDIR } from '../../shared/constants'

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

export class WhisperManager extends EventEmitter {
  getModelsDir(): string {
    return join(app.getPath('home'), RECORDING_DIR_NAME, MODELS_SUBDIR)
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
      await this.downloadWithRetry(() => this.downloadWhisper(), 'whisper-cpp')
    }
    if (!(await this.fileExists(this.getFfmpegPath()))) {
      await this.downloadWithRetry(() => this.downloadFfmpeg(), 'ffmpeg')
    }
    if (!(await this.fileExists(this.getModelPath()))) {
      await this.downloadWithRetry(() => this.downloadModel(), 'model')
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

  private async downloadWhisper(): Promise<void> {
    // NOTE: The exact URL must be verified against the latest whisper.cpp GitHub Release.
    // Check https://github.com/ggerganov/whisper.cpp/releases for current asset names.
    const url = this.getWhisperDownloadUrl()
    await this.downloadFile(url, this.getWhisperPath(), 'whisper-cpp')
    await chmod(this.getWhisperPath(), 0o755)
  }

  private async downloadFfmpeg(): Promise<void> {
    const url = this.getFfmpegDownloadUrl()
    const zipPath = this.getFfmpegPath() + '.zip'
    await this.downloadFile(url, zipPath, 'ffmpeg')
    const { execSync } = await import('child_process')
    execSync(`unzip -o -j "${zipPath}" -d "${this.getModelsDir()}"`)
    await chmod(this.getFfmpegPath(), 0o755)
    const { unlink } = await import('fs/promises')
    await unlink(zipPath).catch(() => {})
  }

  private async downloadModel(): Promise<void> {
    const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
    await this.downloadFile(url, this.getModelPath(), 'ggml-large-v3.bin')
  }

  private getWhisperDownloadUrl(): string {
    const platform = process.platform
    const arch = process.arch
    if (platform === 'darwin' && arch === 'arm64') {
      // TODO: Verify exact asset name from latest GitHub Release at implementation time
      return 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-cli-darwin-arm64'
    }
    throw new Error(`Unsupported platform: ${platform} ${arch}`)
  }

  private getFfmpegDownloadUrl(): string {
    const platform = process.platform
    if (platform === 'darwin') {
      return 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
    }
    throw new Error(`Unsupported platform: ${platform}`)
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
