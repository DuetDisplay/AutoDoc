import { app } from 'electron'
import { access, mkdir, chmod, rm, copyFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { spawn, execFile, execSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { DEFAULT_OLLAMA_MODEL, MODELS_SUBDIR } from '../../shared/constants'
import { getInstalledModelsDir, getInstalledOllamaDataDir } from './dev-runtime-paths'
import { canUseSystemRuntimeFallback } from './runtime-policy'

const IS_WIN = process.platform === 'win32'

const OLLAMA_PORT = 11435 // Use a non-default port to avoid conflicts with user's own Ollama
const OLLAMA_HOST = `127.0.0.1:${OLLAMA_PORT}`
const OLLAMA_BASE_URL = `http://${OLLAMA_HOST}`
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'
const TEST_OLLAMA_SETUP_SEQUENCE =
  IS_WIN && IS_TEST_RUNTIME && process.env.AUTODOC_TEST_REAL_SETUP === '1'
    ? (process.env.AUTODOC_TEST_OLLAMA_SETUP_SEQUENCE ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

function consumeTestOllamaSetupStep(): string | null {
  return TEST_OLLAMA_SETUP_SEQUENCE.shift() ?? null
}

export class OllamaManager extends EventEmitter {
  private process: ChildProcess | null = null
  private model: string
  private readyPromise: Promise<void> | null = null

  constructor(model?: string) {
    super()
    this.model = model ?? DEFAULT_OLLAMA_MODEL
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startAndPull(): Promise<void> {
    if (!this.readyPromise) {
      const testStep = consumeTestOllamaSetupStep()
      this.readyPromise = (
        testStep ? this.runTestSetupStep(testStep) : this.start().then(() => this.pullModel())
      ).catch((err) => {
        // Reset so the next call retries instead of permanently failing
        this.readyPromise = null
        throw err
      })
    }
    return this.readyPromise
  }

  private async runTestSetupStep(step: string): Promise<void> {
    if (step === 'download-fail') {
      this.emit('download-start', 'ollama')
      await Promise.resolve()
      throw new TypeError('terminated')
    }

    if (step === 'ready') {
      this.emit('download-start', 'ollama')
      this.emit('download-progress', { file: 'ollama', percent: 100 })
      this.emit('download-complete', 'ollama')
      this.emit('pull-start', this.model)
      this.emit('pull-progress', { model: this.model, percent: 100, status: 'success' })
      this.emit('pull-complete', this.model)
      return
    }

    await this.start()
    await this.pullModel()
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

  private getRuntimeDir(): string {
    return join(this.getModelsDir(), 'ollama-runtime')
  }

  private getBinaryPath(): string {
    return join(this.getRuntimeDir(), IS_WIN ? 'ollama.exe' : 'ollama')
  }

  private getOllamaDataDir(): string {
    return this.getInstalledFallbackOllamaDataDir() ?? join(app.getPath('userData'), 'ollama-data')
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
        signal: AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  async hasModel(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000)
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
    await mkdir(this.getRuntimeDir(), { recursive: true })
    await mkdir(this.getOllamaDataDir(), { recursive: true })

    await this.adoptInstalledRuntimeIfAvailable()

    if (!(await this.isReady())) {
      if (canUseSystemRuntimeFallback()) {
        const systemBinary = this.findSystemOllama()
        if (systemBinary) {
          await copyFile(systemBinary, this.getBinaryPath())
          return
        }
      }

      await this.downloadBinary()
    }
  }

  private getInstalledFallbackOllamaDataDir(): string | null {
    const installedOllamaDataDir = getInstalledOllamaDataDir()
    if (
      !installedOllamaDataDir ||
      installedOllamaDataDir === join(app.getPath('userData'), 'ollama-data') ||
      !existsSync(installedOllamaDataDir)
    ) {
      return null
    }

    return installedOllamaDataDir
  }

  private async adoptInstalledRuntimeIfAvailable(): Promise<void> {
    const installedModelsDir = getInstalledModelsDir()
    if (!installedModelsDir || installedModelsDir === this.getModelsDir()) {
      return
    }

    const installedRuntimeDir = join(installedModelsDir, 'ollama-runtime')
    if (!(await this.fileExists(installedRuntimeDir))) {
      return
    }

    await this.copyDirectoryContentsIfMissing(installedRuntimeDir, this.getRuntimeDir())
  }

  private findSystemOllama(): string | null {
    try {
      const cmd = IS_WIN ? 'where.exe ollama.exe' : 'which ollama'
      const result = execSync(cmd, { encoding: 'utf-8' }).trim()
      return result.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  async start(): Promise<void> {
    await this.ensureReady()

    if (await this.isServerRunning()) return

    // Kill any orphaned process holding our port from a previous app session
    this.killProcessOnPort()
    await new Promise((r) => setTimeout(r, 1000))

    await new Promise<void>((resolve, reject) => {
      const binary = this.getBinaryPath()
      const proc = spawn(binary, ['serve'], {
        env: {
          ...process.env,
          OLLAMA_HOST: OLLAMA_HOST,
          OLLAMA_MODELS: this.getOllamaDataDir()
        },
        stdio: ['ignore', 'pipe', 'pipe']
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
      if (IS_WIN) {
        spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t']).on('error', () => {})
      } else {
        this.process.kill('SIGTERM')
      }
      this.process = null
    }
    // Also kill any process on our port that we didn't spawn (adopted from a previous session)
    this.killProcessOnPort()
    this.readyPromise = null
  }

  /** Clear cached ready state so the next startAndPull() actually restarts. */
  resetReady(): void {
    this.readyPromise = null
  }

  /**
   * Find and kill any process listening on our port.
   * Handles orphaned Ollama processes left behind by a previous app session
   * where start() found an existing server and never tracked its PID.
   */
  private killProcessOnPort(): void {
    try {
      if (IS_WIN) {
        const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${OLLAMA_PORT}"`, {
          encoding: 'utf-8',
          timeout: 5000
        }).trim()
        const pids = new Set<string>()
        for (const line of output.split(/\r?\n/)) {
          const pid = line.trim().split(/\s+/).pop()
          if (pid && pid !== '0') pids.add(pid)
        }
        for (const pid of pids) {
          try {
            execSync(`taskkill /pid ${pid} /f /t`, { timeout: 5000 })
          } catch {
            // already dead
          }
        }
      } else {
        const pids = execSync(`lsof -ti :${OLLAMA_PORT}`, {
          encoding: 'utf-8',
          timeout: 5000
        }).trim()
        for (const pid of pids.split(/\n/)) {
          if (pid) {
            try {
              process.kill(Number(pid), 'SIGKILL')
            } catch {
              // already dead
            }
          }
        }
      }
    } catch {
      // No process found on the port - nothing to clean up
    }
  }

  async pullModel(): Promise<void> {
    if (await this.hasModel()) {
      this.emit('pull-complete', this.model)
      return
    }

    this.emit('pull-start', this.model)

    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.model, stream: true })
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
              status: data.status ?? 'downloading'
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
    this.emit('download-start', 'ollama')
    const runtimeDir = this.getRuntimeDir()

    if (IS_WIN) {
      await this.downloadBinaryWindows(runtimeDir)
    } else {
      await this.downloadBinaryUnix(runtimeDir)
    }

    this.emit('download-complete', 'ollama')
  }

  private async downloadBinaryWindows(runtimeDir: string): Promise<void> {
    const url = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'
    const zipPath = join(runtimeDir, 'ollama.zip')

    await this.downloadToFile(url, zipPath)

    // Extract using PowerShell's Expand-Archive
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${runtimeDir}'`
        ],
        (err) => {
          if (err) reject(new Error(`Failed to extract Ollama: ${err.message}`))
          else resolve()
        }
      )
    })

    await rm(zipPath, { force: true })
  }

  private async downloadBinaryUnix(runtimeDir: string): Promise<void> {
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    const url = `https://github.com/ollama/ollama/releases/latest/download/ollama-${platform}.tgz`
    const tgzPath = join(runtimeDir, 'ollama.tgz')

    await this.downloadToFile(url, tgzPath)

    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['xzf', tgzPath, '-C', runtimeDir, 'ollama'], (err) => {
        if (err) reject(new Error(`Failed to extract Ollama: ${err.message}`))
        else resolve()
      })
    })

    await chmod(this.getBinaryPath(), 0o755)
    await rm(tgzPath, { force: true })
  }

  private async downloadToFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      throw new Error(`Failed to download Ollama: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0

    const fileStream = createWriteStream(destPath)
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
          bytesTotal: totalBytes
        })
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath)
      return true
    } catch {
      return false
    }
  }

  private async copyDirectoryContentsIfMissing(sourceDir: string, destDir: string): Promise<void> {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const destPath = join(destDir, entry.name)

      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true })
        await this.copyDirectoryContentsIfMissing(sourcePath, destPath)
        continue
      }

      if (!entry.isFile() || (await this.fileExists(destPath))) {
        continue
      }

      await copyFile(sourcePath, destPath)
      if (!IS_WIN && entry.name === 'ollama') {
        await chmod(destPath, 0o755)
      }
    }
  }
}
