import { app } from 'electron'
import { access, mkdir, chmod, rm, copyFile, readdir, mkdtemp, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createWriteStream } from 'fs'
import { spawn, execFile, execSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_MODEL,
  MODELS_SUBDIR
} from '../../shared/constants'
import { getInstalledModelsDir, getInstalledOllamaDataDir } from './dev-runtime-paths'
import { canUseSystemRuntimeFallback } from './runtime-policy'

const OLLAMA_DOWNLOAD_VERSION = 'v0.30.0'
const IS_WIN = process.platform === 'win32'

const OLLAMA_PORT = 11435 // Use a non-default port to avoid conflicts with user's own Ollama
const OLLAMA_HOST = `127.0.0.1:${OLLAMA_PORT}`
const OLLAMA_BASE_URL = `http://${OLLAMA_HOST}`
const NEVER_ABORT_SIGNAL = new AbortController().signal
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'
const SHOULD_PULL_ASK_AI_EMBEDDING_MODEL =
  !IS_TEST_RUNTIME && process.env.AUTODOC_ASK_AI_EMBEDDINGS !== '0'
const TEST_OLLAMA_SETUP_SEQUENCE =
  IS_WIN && IS_TEST_RUNTIME && process.env.AUTODOC_TEST_REAL_SETUP === '1'
    ? (process.env.AUTODOC_TEST_OLLAMA_SETUP_SEQUENCE ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

type PreferredModelResolver = () => string | null | undefined | Promise<string | null | undefined>

interface ActiveSetup {
  generation: number
  controller: AbortController
  promise: Promise<void>
}

export interface OllamaManagerOptions {
  model?: string
  resolveModel?: PreferredModelResolver
}

export class OllamaSetupCancelledError extends Error {
  constructor() {
    super('Managed Ollama setup was cancelled')
    this.name = 'OllamaSetupCancelledError'
  }
}

export function isOllamaSetupCancellation(error: unknown): boolean {
  return (
    error instanceof OllamaSetupCancelledError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OllamaSetupCancelledError()
  }
}

function getSafeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN'
  const code = (error as NodeJS.ErrnoException).code
  if (code && /^[A-Z0-9_]+$/.test(code)) return code
  return error.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'ERROR'
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OllamaSetupCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function consumeTestOllamaSetupStep(): string | null {
  return TEST_OLLAMA_SETUP_SEQUENCE.shift() ?? null
}

export class OllamaManager extends EventEmitter {
  private process: ChildProcess | null = null
  private model: string
  private resolveModel: PreferredModelResolver | null
  private readyPromise: Promise<void> | null = null
  private activeSetup: ActiveSetup | null = null
  private setupGeneration = 0
  private extractionProcess: ChildProcess | null = null
  private setupSuspended = false
  private adoptedSystemRuntime = false

  constructor(modelOrOptions?: string | OllamaManagerOptions) {
    super()
    const options =
      typeof modelOrOptions === 'string' ? { model: modelOrOptions } : (modelOrOptions ?? {})
    this.model = options.model ?? DEFAULT_OLLAMA_MODEL
    this.resolveModel = options.resolveModel ?? null
  }

  /** Call once at startup. Subsequent calls return the same promise. */
  startAndPull(): Promise<void> {
    if (this.setupSuspended) {
      return Promise.reject(new OllamaSetupCancelledError())
    }
    if (this.readyPromise) return this.readyPromise

    const generation = ++this.setupGeneration
    const controller = new AbortController()
    const setupPromise = this.runSetup(controller.signal)
    const trackedPromise = setupPromise.then(
      () => {
        if (
          this.activeSetup?.generation === generation &&
          this.activeSetup.promise === trackedPromise
        ) {
          this.activeSetup = null
        }
      },
      (error: unknown) => {
        const normalizedError =
          controller.signal.aborted && !isOllamaSetupCancellation(error)
            ? new OllamaSetupCancelledError()
            : error
        if (
          this.activeSetup?.generation === generation &&
          this.activeSetup.promise === trackedPromise
        ) {
          this.activeSetup = null
          if (this.readyPromise === trackedPromise) {
            this.readyPromise = null
          }
        }
        throw normalizedError
      }
    )

    this.activeSetup = { generation, controller, promise: trackedPromise }
    this.readyPromise = trackedPromise
    return trackedPromise
  }

  private async runSetup(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    await this.selectPreferredModel()
    throwIfAborted(signal)

    const testStep = consumeTestOllamaSetupStep()
    if (testStep) {
      await this.runTestSetupStep(testStep, signal)
      return
    }

    await this.start(signal)
    throwIfAborted(signal)
    await this.pullModel(this.model, signal)
    throwIfAborted(signal)
    await this.pullOptionalEmbeddingModel(signal)
  }

  private async runTestSetupStep(step: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (step === 'download-fail') {
      this.emit('download-start', 'ollama')
      await Promise.resolve()
      throwIfAborted(signal)
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

    await this.start(signal)
    await this.pullModel(this.model, signal)
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
    if (this.model === model) return
    this.model = model
    this.emit('model-selected', model)
  }

  private async selectPreferredModel(): Promise<void> {
    if (!this.resolveModel) return

    const preferredModel = await this.resolveModel()
    if (!preferredModel) return

    this.setModel(preferredModel)
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

  private getLlamaServerPath(): string {
    return join(this.getRuntimeDir(), 'llama-server')
  }

  private getOllamaDataDir(): string {
    return this.getInstalledFallbackOllamaDataDir() ?? join(app.getPath('userData'), 'ollama-data')
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getBinaryPath())
      if (process.platform === 'darwin' && !this.adoptedSystemRuntime) {
        await access(this.getLlamaServerPath())
      }
      return true
    } catch {
      return false
    }
  }

  async isServerRunning(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
          : AbortSignal.timeout(2000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  async hasModel(model = this.model, signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
          : AbortSignal.timeout(3000)
      })
      if (!res.ok) return false
      const data = (await res.json()) as { models?: { name: string }[] }
      return data.models?.some((m) => m.name === model || m.name.startsWith(`${model}:`)) ?? false
    } catch {
      if (signal?.aborted) throw new OllamaSetupCancelledError()
      return false
    }
  }

  async ensureReady(signal: AbortSignal = NEVER_ABORT_SIGNAL): Promise<void> {
    throwIfAborted(signal)
    await mkdir(this.getModelsDir(), { recursive: true })
    await mkdir(this.getRuntimeDir(), { recursive: true })
    await mkdir(this.getOllamaDataDir(), { recursive: true })

    await this.adoptInstalledRuntimeIfAvailable()
    throwIfAborted(signal)

    if (!(await this.isReady())) {
      if (canUseSystemRuntimeFallback()) {
        const systemBinary = this.findSystemOllama()
        if (systemBinary) {
          await copyFile(systemBinary, this.getBinaryPath())
          this.adoptedSystemRuntime = true
          return
        }
      }

      await this.downloadBinary(signal)
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

  async start(signal: AbortSignal = NEVER_ABORT_SIGNAL): Promise<void> {
    await this.ensureReady(signal)
    throwIfAborted(signal)

    if (await this.isServerRunning(signal)) return
    throwIfAborted(signal)

    // Kill any orphaned process holding our port from a previous app session
    this.killProcessOnPort()
    await abortableDelay(1000, signal)

    await new Promise<void>((resolve, reject) => {
      throwIfAborted(signal)
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
      let settled = false
      let pollInterval: ReturnType<typeof setInterval> | null = null
      let timeout: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (pollInterval) clearInterval(pollInterval)
        if (timeout) clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        proc.removeListener('error', onStartError)
        proc.removeListener('exit', onStartExit)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        void this.stopProcessAndWait(proc).then(
          () => {
            if (this.process === proc) this.process = null
            fail(new OllamaSetupCancelledError())
          },
          (error: Error) => fail(error)
        )
      }
      const onStartError = (error: Error): void => {
        if (this.process === proc) this.process = null
        fail(new Error(`Failed to start managed Ollama (${getSafeErrorCode(error)})`))
      }
      const onStartExit = (code: number | null): void => {
        if (code !== null && code !== 0) {
          fail(new Error(`Managed Ollama exited before startup completed (code ${code})`))
        }
      }

      proc.once('exit', () => {
        if (this.process === proc) this.process = null
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr = `${stderr}${data.toString()}`.slice(-4096)
        // Ollama logs "Listening on ..." to stderr when ready
        if (stderr.includes('Listening on')) {
          succeed()
        }
      })

      proc.once('error', onStartError)
      proc.once('exit', onStartExit)
      signal.addEventListener('abort', onAbort, { once: true })

      // Fallback: poll for readiness if we miss the log line
      pollInterval = setInterval(() => {
        void this.isServerRunning(signal)
          .then((isRunning) => {
            if (isRunning) succeed()
          })
          .catch((error: unknown) => {
            if (signal.aborted) fail(new OllamaSetupCancelledError())
            else fail(error instanceof Error ? error : new Error('Managed Ollama startup failed'))
          })
      }, 500)

      // Timeout after 30 seconds
      timeout = setTimeout(() => {
        fail(new Error('Managed Ollama server failed to start within 30 seconds'))
      }, 30_000)
    })
  }

  stop(): void {
    this.setupSuspended = true
    const activeSetup = this.activeSetup
    if (activeSetup) {
      activeSetup.controller.abort()
      void activeSetup.promise.catch(() => {})
    }
    this.stopManagedProcesses()
    // Also kill any process on our port that we didn't spawn (adopted from a previous session)
    this.killProcessOnPort()
    if (!activeSetup && this.readyPromise) {
      this.readyPromise = null
    }
  }

  /**
   * Cancel setup and wait for all setup-owned file/process work to settle before
   * callers delete managed component directories.
   */
  async cancelSetup(): Promise<void> {
    this.setupSuspended = true
    const activeSetup = this.activeSetup
    if (activeSetup) {
      activeSetup.controller.abort()
      await activeSetup.promise.catch(() => {})
      if (this.readyPromise === activeSetup.promise) {
        this.readyPromise = null
      }
      if (this.activeSetup?.generation === activeSetup.generation) {
        this.activeSetup = null
      }
    } else {
      this.readyPromise = null
    }
    await this.stopManagedProcessesAndWait()
    this.killProcessOnPort()
  }

  /** Allow a fresh setup only after the caller's destructive clear has settled. */
  resumeSetup(): void {
    this.setupSuspended = false
  }

  /** Clear cached ready state so the next startAndPull() actually restarts. */
  resetReady(): void {
    // Never detach a live attempt. Clear/reset paths must cancelSetup() and await it.
    if (!this.activeSetup) {
      this.readyPromise = null
    }
  }

  private stopManagedProcesses(): void {
    if (this.extractionProcess) {
      this.stopProcess(this.extractionProcess)
      this.extractionProcess = null
    }
    if (this.process) {
      this.stopProcess(this.process)
      this.process = null
    }
  }

  private async stopManagedProcessesAndWait(): Promise<void> {
    const processes = [this.extractionProcess, this.process].filter(
      (process): process is ChildProcess => process != null
    )
    this.extractionProcess = null
    this.process = null
    await Promise.all(processes.map((process) => this.stopProcessAndWait(process)))
  }

  private stopProcess(proc: ChildProcess): void {
    if (IS_WIN) {
      if (proc.pid != null) {
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']).on('error', () => {})
      }
    } else {
      proc.kill('SIGTERM')
    }
  }

  private async stopProcessAndWait(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null) return

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        proc.removeListener('exit', finish)
        resolve()
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        proc.removeListener('exit', finish)
        reject(new Error('Managed Ollama process did not stop within 5 seconds'))
      }, 5_000)

      proc.once('exit', finish)
      if (IS_WIN) {
        if (proc.pid == null) {
          finish()
          return
        }
        const taskkill = spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'])
        taskkill.once('error', () => {})
        taskkill.once('exit', finish)
        return
      }

      if (!proc.kill('SIGTERM')) {
        finish()
      }
    })
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

  async pullModel(model = this.model, signal: AbortSignal = NEVER_ABORT_SIGNAL): Promise<void> {
    throwIfAborted(signal)
    if (await this.hasModel(model, signal)) {
      this.emit('pull-complete', model)
      return
    }

    this.emit('pull-start', model)

    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal
    })

    if (!res.ok) {
      throw new Error(`Failed to pull model ${model}: ${res.status}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body from pull')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error) {
        if (signal.aborted || isOllamaSetupCancellation(error)) {
          throw new OllamaSetupCancelledError()
        }
        throw error
      }
      const { done, value } = result
      if (done) break
      throwIfAborted(signal)

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const data = JSON.parse(line) as { status?: string; total?: number; completed?: number }
          if (data.total && data.completed) {
            this.emit('pull-progress', {
              model,
              percent: Math.round((data.completed / data.total) * 100),
              status: data.status ?? 'downloading'
            })
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    this.emit('pull-complete', model)
  }

  private async pullOptionalEmbeddingModel(signal: AbortSignal): Promise<void> {
    if (!SHOULD_PULL_ASK_AI_EMBEDDING_MODEL) return
    const model = process.env.AUTODOC_ASK_AI_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_MODEL
    try {
      await this.pullModel(model, signal)
    } catch (error) {
      if (signal.aborted || isOllamaSetupCancellation(error)) {
        throw new OllamaSetupCancelledError()
      }
      this.emit('pull-complete', model)
    }
  }

  private async downloadBinary(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    this.emit('download-start', 'ollama')
    const stagingDir = await mkdtemp(join(this.getModelsDir(), '.ollama-runtime-staging-'))

    try {
      if (IS_WIN) {
        await this.downloadBinaryWindows(stagingDir, signal)
      } else {
        await this.downloadBinaryUnix(stagingDir, signal)
      }
      throwIfAborted(signal)
      await this.promoteStagedRuntime(stagingDir, signal)
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      if (signal.aborted || isOllamaSetupCancellation(error)) {
        throw new OllamaSetupCancelledError()
      }
      throw new Error(`Failed to install managed Ollama runtime (${getSafeErrorCode(error)})`)
    }

    this.emit('download-complete', 'ollama')
  }

  private async downloadBinaryWindows(runtimeDir: string, signal: AbortSignal): Promise<void> {
    const url = `https://github.com/ollama/ollama/releases/download/${OLLAMA_DOWNLOAD_VERSION}/ollama-windows-amd64.zip`
    const zipPath = join(runtimeDir, 'ollama.zip')

    await this.downloadToFile(url, zipPath, signal)

    // Extract using PowerShell's Expand-Archive
    await this.extractWithCommand(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${runtimeDir}'`
      ],
      signal
    )

    await rm(zipPath, { force: true })
    await access(join(runtimeDir, 'ollama.exe'))
  }

  private async downloadBinaryUnix(runtimeDir: string, signal: AbortSignal): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Managed Ollama downloads are only supported on macOS and Windows')
    }

    const archiveName = 'ollama-darwin.tgz'
    const archivePath = join(runtimeDir, archiveName)
    const url = `https://github.com/ollama/ollama/releases/download/${OLLAMA_DOWNLOAD_VERSION}/${archiveName}`

    await this.downloadToFile(url, archivePath, signal)
    await this.extractWithCommand('tar', ['xzf', archivePath, '-C', runtimeDir], signal)

    const binaryPath = join(runtimeDir, 'ollama')
    const llamaServerPath = join(runtimeDir, 'llama-server')
    await access(binaryPath)
    await access(llamaServerPath)
    await chmod(binaryPath, 0o755)
    await chmod(llamaServerPath, 0o755)
    await rm(archivePath, { force: true })
  }

  private async downloadToFile(url: string, destPath: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const response = await fetch(url, { redirect: 'follow', signal })
    if (!response.ok) {
      throw new Error(`Failed to download Ollama: ${response.status} ${response.statusText}`)
    }

    if (!response.body) throw new Error('No response body for Ollama download')

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0
    await mkdir(dirname(destPath), { recursive: true })
    throwIfAborted(signal)

    try {
      const progress = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          if (signal.aborted) {
            callback(new OllamaSetupCancelledError())
            return
          }
          downloadedBytes += chunk.length
          this.emit('download-progress', {
            file: 'ollama',
            percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
            bytesDownloaded: downloadedBytes,
            bytesTotal: totalBytes
          })
          callback(null, chunk)
        }
      })
      const source = Readable.from(response.body as unknown as AsyncIterable<Uint8Array>)
      await pipeline(source, progress, createWriteStream(destPath, { flags: 'wx' }), { signal })
    } catch (error) {
      await rm(destPath, { force: true }).catch(() => {})
      if (signal.aborted || isOllamaSetupCancellation(error)) {
        throw new OllamaSetupCancelledError()
      }
      throw error
    }
  }

  private async extractWithCommand(
    command: string,
    args: string[],
    signal: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal)
    await new Promise<void>((resolve, reject) => {
      const child = execFile(command, args, { signal }, (error) => {
        if (this.extractionProcess === child) this.extractionProcess = null
        if (!error) {
          resolve()
          return
        }
        if (signal.aborted || isOllamaSetupCancellation(error)) {
          reject(new OllamaSetupCancelledError())
          return
        }
        reject(new Error(`Failed to extract managed Ollama runtime (${getSafeErrorCode(error)})`))
      })
      this.extractionProcess = child
    })
  }

  private async promoteStagedRuntime(stagingDir: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const runtimeDir = this.getRuntimeDir()
    await rm(runtimeDir, { recursive: true, force: true })
    throwIfAborted(signal)
    await rename(stagingDir, runtimeDir)
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
      if (!IS_WIN && (entry.name === 'ollama' || entry.name === 'llama-server')) {
        await chmod(destPath, 0o755)
      }
    }
  }
}
