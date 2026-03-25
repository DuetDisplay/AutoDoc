import { app } from 'electron'
import { access, mkdir, chmod, rm } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { MODELS_SUBDIR } from '../../shared/constants'

const DEFAULT_MODEL = 'llama3'
const OLLAMA_PORT = 11435 // Use a non-default port to avoid conflicts with user's own Ollama
const OLLAMA_HOST = `127.0.0.1:${OLLAMA_PORT}`
const OLLAMA_BASE_URL = `http://${OLLAMA_HOST}`

export class OllamaManager extends EventEmitter {
  private process: ChildProcess | null = null
  private model: string
  private readyPromise: Promise<void> | null = null

  constructor(model?: string) {
    super()
    this.model = model ?? DEFAULT_MODEL
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startAndPull(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.start()
        .then(() => this.pullModel())
        .catch((err) => {
          // Reset so the next call retries instead of permanently failing
          this.readyPromise = null
          throw err
        })
    }
    return this.readyPromise
  }

  /** Wait for startup + model pull to complete. */
  waitUntilReady(): Promise<void> {
    return this.readyPromise ?? this.startAndPull()
  }

  getBaseUrl(): string {
    return OLLAMA_BASE_URL
  }

  getModel(): string {
    return this.model
  }

  setModel(model: string): void {
    this.model = model
  }

  private getModelsDir(): string {
    return join(app.getPath('userData'), MODELS_SUBDIR)
  }

  private getBinaryPath(): string {
    return join(this.getModelsDir(), 'ollama')
  }

  private getOllamaDataDir(): string {
    return join(app.getPath('userData'), 'ollama-data')
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getBinaryPath())
      return true
    } catch {
      return false
    }
  }

  async isServerRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async hasModel(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return false
      const data = (await res.json()) as { models?: { name: string }[] }
      return data.models?.some((m) => m.name.startsWith(this.model)) ?? false
    } catch {
      return false
    }
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.getModelsDir(), { recursive: true })
    await mkdir(this.getOllamaDataDir(), { recursive: true })

    if (!(await this.isReady())) {
      await this.downloadBinary()
    }
  }

  async start(): Promise<void> {
    await this.ensureReady()

    if (await this.isServerRunning()) return

    await new Promise<void>((resolve, reject) => {
      const binary = this.getBinaryPath()
      const proc = spawn(binary, ['serve'], {
        env: {
          ...process.env,
          OLLAMA_HOST: OLLAMA_HOST,
          OLLAMA_MODELS: this.getOllamaDataDir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.process = proc

      let stderr = ''
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        // Ollama logs "Listening on ..." to stderr when ready
        if (stderr.includes('Listening on')) {
          resolve()
        }
      })

      proc.on('error', (err) => {
        this.process = null
        reject(new Error(`Failed to start Ollama: ${err.message}`))
      })

      proc.on('exit', (code) => {
        this.process = null
        if (code !== null && code !== 0) {
          reject(new Error(`Ollama exited with code ${code}: ${stderr.slice(-300)}`))
        }
      })

      // Fallback: poll for readiness if we miss the log line
      const pollInterval = setInterval(async () => {
        if (await this.isServerRunning()) {
          clearInterval(pollInterval)
          resolve()
        }
      }, 500)

      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(pollInterval)
        reject(new Error('Ollama server failed to start within 30 seconds'))
      }, 30_000)
    })
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  async pullModel(): Promise<void> {
    if (await this.hasModel()) return

    this.emit('pull-start', this.model)

    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.model, stream: true }),
    })

    if (!res.ok) {
      throw new Error(`Failed to pull model ${this.model}: ${res.status}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body from pull')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line) as { status?: string; total?: number; completed?: number }
          if (data.total && data.completed) {
            this.emit('pull-progress', {
              model: this.model,
              percent: Math.round((data.completed / data.total) * 100),
              status: data.status ?? 'downloading',
            })
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    this.emit('pull-complete', this.model)
  }

  private async downloadBinary(): Promise<void> {
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const url = `https://github.com/ollama/ollama/releases/latest/download/ollama-${platform}.tgz`

    this.emit('download-start', 'ollama')

    const modelsDir = this.getModelsDir()
    const tgzPath = join(modelsDir, 'ollama.tgz')

    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`Failed to download Ollama: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0

    const fileStream = createWriteStream(tgzPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body for Ollama download')

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fileStream.write(value)
        downloadedBytes += value.length
        this.emit('download-progress', {
          file: 'ollama',
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes,
        })
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }

    // Extract the ollama binary from the tgz (binary is at archive root)
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['xzf', tgzPath, '-C', modelsDir, 'ollama'], (err) => {
        if (err) reject(new Error(`Failed to extract Ollama: ${err.message}`))
        else resolve()
      })
    })

    await chmod(this.getBinaryPath(), 0o755)
    await rm(tgzPath, { force: true })
    this.emit('download-complete', 'ollama')
  }
}
