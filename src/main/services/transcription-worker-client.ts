import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { logAutodocEvent } from './autodoc-log'

/**
 * JSON-lines-over-stdio protocol for the persistent transcription worker.
 *
 * Requests (one JSON object per line on stdin):
 * - load: {"id", "op": "load", "engine": "faster-whisper", "model", "device": "cuda"|"cpu", "computeType", "threads": number|null}
 * - transcribe: {"id", "op": "transcribe", "audio", "language", "window": {"startSec", "endSec"} | null}
 * - unload: {"id", "op": "unload"}
 * - ping: {"id", "op": "ping"}
 *
 * Responses on stdout (one JSON object per line):
 * - success: {"id", "ok": true, "result": ...}
 * - failure: {"id", "ok": false, "error": string}
 *
 * transcribe result shape:
 * {"transcription": [{"offsets": {"from": ms, "to": ms}, "text": string}]}
 *
 * When window is set, segment offsets in transcribe results and segment events are
 * RELATIVE TO THE WINDOW START (the caller adds chunkStart * 1000, matching existing chunk logic).
 *
 * Unsolicited progress events on stdout:
 * {"event": "segment", "id", "startMs", "endMs", "text"}
 * Emitted as each segment decodes. Window-relative when windowed.
 */

export type TranscriptionWorkerDevice = 'cuda' | 'cpu'

export interface TranscriptionWorkerWindow {
  startSec: number
  endSec: number
}

export interface TranscriptionWorkerLoadParams {
  engine: 'faster-whisper'
  model: string
  device: TranscriptionWorkerDevice
  computeType: string
  threads: number | null
}

export interface TranscriptionWorkerTranscribeParams {
  audio: string
  language: string
  window: TranscriptionWorkerWindow | null
}

export interface TranscriptionWorkerSegment {
  offsets: { from: number; to: number }
  text: string
}

export interface TranscriptionWorkerTranscribeResult {
  transcription: TranscriptionWorkerSegment[]
}

export interface TranscriptionWorkerSegmentEvent {
  id: number
  startMs: number
  endMs: number
  text: string
}

type TranscriptionWorkerSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess

export interface TranscriptionWorkerClientOptions {
  pythonPath: string
  scriptPath: string
  processEnv: NodeJS.ProcessEnv
  applyPriority?: (pid: number | undefined) => void
  extraArgs?: string[]
  spawnFn?: TranscriptionWorkerSpawnFn
  idleUnloadMs?: number
  idleKillMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onSegment?: (event: TranscriptionWorkerSegmentEvent) => void
}

const STDERR_TAIL_MAX_CHARS = 4000
const WINDOWS_FAST_WHISPER_NATIVE_CRASH_CODES = new Set([3221226505, -1073740791])

export class TranscriptionWorkerClient {
  private process: ChildProcess | null = null
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stderrTail = ''
  private loaded = false
  private respawnAllowed = true
  private hasSpawnedProcess = false
  private idleUnloadTimer: ReturnType<typeof setTimeout> | null = null
  private idleKillTimer: ReturnType<typeof setTimeout> | null = null
  private inFlightRequests = 0
  private disposed = false
  private idleKilled = false
  private idleLifecycleActive = false
  private readonly idleUnloadMs: number
  private readonly idleKillMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(private readonly options: TranscriptionWorkerClientOptions) {
    this.idleUnloadMs = options.idleUnloadMs ?? 5 * 60_000
    this.idleKillMs = options.idleKillMs ?? 10 * 60_000
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  async load(params: TranscriptionWorkerLoadParams): Promise<void> {
    const result = (await this.request('load', { ...params })) as { loaded?: boolean }
    this.loaded = result.loaded === true
  }

  async transcribe(
    params: TranscriptionWorkerTranscribeParams,
    onSegment?: (event: TranscriptionWorkerSegmentEvent) => void
  ): Promise<TranscriptionWorkerTranscribeResult> {
    return (await this.request(
      'transcribe',
      { ...params },
      onSegment
    )) as TranscriptionWorkerTranscribeResult
  }

  async unload(): Promise<void> {
    await this.request('unload', {})
    this.loaded = false
  }

  async ping(): Promise<void> {
    await this.request('ping', {})
  }

  dispose(): void {
    this.disposed = true
    this.clearIdleTimers()
    this.rejectAllPending(new Error('Transcription worker client disposed'))
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
    this.loaded = false
  }

  private async request(
    op: string,
    payload: Record<string, unknown>,
    onSegment?: (event: TranscriptionWorkerSegmentEvent) => void,
    internal = false
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Transcription worker client disposed')
    }

    if (!internal) {
      // Any external request cancels the idle lifecycle so it re-arms cleanly
      // once the worker goes quiet again.
      this.clearIdleTimers()
      this.idleLifecycleActive = false
    }
    await this.ensureProcess()

    const id = this.nextRequestId++
    this.inFlightRequests += 1

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, onSegment })
      try {
        this.writeRequest({ id, op, ...payload })
      } catch (error) {
        this.pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }).finally(() => {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1)
      if (!internal && this.inFlightRequests === 0 && !this.idleLifecycleActive) {
        this.scheduleIdleTimers()
      }
    })
  }

  private writeRequest(request: Record<string, unknown>): void {
    if (!this.process?.stdin || this.process.stdin.destroyed) {
      throw new Error('Transcription worker stdin unavailable')
    }

    this.process.stdin.write(`${JSON.stringify(request)}\n`)
  }

  private async ensureProcess(): Promise<void> {
    if (this.process && !this.process.killed) {
      return
    }

    if (this.disposed) {
      throw new Error('Transcription worker client disposed')
    }

    if (this.hasSpawnedProcess && !this.idleKilled) {
      if (!this.respawnAllowed) {
        throw new Error(`Transcription worker crashed repeatedly: ${this.stderrTail.slice(-500)}`)
      }
      this.respawnAllowed = false
    }
    this.idleKilled = false

    const spawnFn = this.options.spawnFn ?? defaultSpawn
    const args = [this.options.scriptPath, ...(this.options.extraArgs ?? [])]
    const proc = spawnFn(this.options.pythonPath, args, {
      env: this.options.processEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.hasSpawnedProcess = true
    this.process = proc
    this.stdoutBuffer = ''
    this.attachProcessHandlers(proc)
    this.options.applyPriority?.(proc.pid)
  }

  private attachProcessHandlers(proc: ChildProcess): void {
    proc.stdout?.removeAllListeners('data')
    proc.stderr?.removeAllListeners('data')
    proc.removeAllListeners('error')
    proc.removeAllListeners('close')

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString())
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.appendStderrTail(chunk.toString())
    })

    proc.on('error', (error) => {
      this.handleProcessFailure(error)
    })

    proc.on('close', (code, signal) => {
      this.handleProcessExit(code, signal)
    })
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk

    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        this.handleStdoutLine(line)
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.warn(`[transcription-worker] Ignoring non-JSON stdout line: ${line.slice(0, 200)}`)
      return
    }

    if (parsed.event === 'segment') {
      const requestId = parsed.id
      if (typeof requestId !== 'number') {
        return
      }

      const pending = this.pendingRequests.get(requestId)
      if (!pending?.onSegment) {
        return
      }

      pending.onSegment({
        id: requestId,
        startMs: Number(parsed.startMs ?? 0),
        endMs: Number(parsed.endMs ?? 0),
        text: String(parsed.text ?? '')
      })
      return
    }

    const requestId = parsed.id
    if (typeof requestId !== 'number') {
      console.warn(`[transcription-worker] Ignoring response without id: ${line.slice(0, 200)}`)
      return
    }

    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      console.warn(`[transcription-worker] Ignoring unmatched response id=${requestId}`)
      return
    }

    this.pendingRequests.delete(requestId)

    if (parsed.ok === true) {
      this.respawnAllowed = true
      pending.resolve(parsed.result)
      return
    }

    const errorMessage =
      typeof parsed.error === 'string' ? parsed.error : 'Transcription worker request failed'
    pending.reject(new Error(errorMessage))
  }

  private appendStderrTail(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS)
  }

  private handleProcessFailure(error: Error): void {
    const message = `Transcription worker process error: ${error.message}: ${this.stderrTail}`
    this.loaded = false
    this.process = null
    this.rejectAllPending(new Error(message))
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const hadPending = this.pendingRequests.size > 0
    const stderrTail = this.stderrTail
    const exitSuffix =
      code != null ? `code ${code}` : signal != null ? `signal ${signal}` : 'unknown exit'

    this.process = null
    this.loaded = false

    if (hadPending) {
      this.rejectAllPending(
        new Error(`Transcription worker exited with ${exitSuffix}: ${stderrTail.slice(-500)}`)
      )
      return
    }

    if (this.idleKilled) {
      // Leave the flag set: ensureProcess consumes it so an idle-kill respawn
      // does not count against the crash-respawn budget.
      return
    }

    if (
      process.platform === 'win32' &&
      code != null &&
      WINDOWS_FAST_WHISPER_NATIVE_CRASH_CODES.has(code)
    ) {
      logAutodocEvent({
        area: 'transcription',
        message: 'Transcription worker exited with a benign Windows native crash code after idle',
        context: { exitCode: code, signal }
      })
      return
    }

    if (code != null && code !== 0) {
      console.warn(`[transcription-worker] Process exited with ${exitSuffix}`)
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private clearIdleTimers(): void {
    if (this.idleUnloadTimer) {
      this.clearTimeoutFn(this.idleUnloadTimer)
      this.idleUnloadTimer = null
    }
    if (this.idleKillTimer) {
      this.clearTimeoutFn(this.idleKillTimer)
      this.idleKillTimer = null
    }
  }

  private scheduleIdleTimers(): void {
    if (this.disposed || !this.process || this.inFlightRequests > 0) {
      return
    }

    this.idleLifecycleActive = false
    this.idleUnloadTimer = this.setTimeoutFn(() => {
      this.idleUnloadTimer = null
      if (this.disposed || !this.process || this.inFlightRequests > 0) {
        return
      }

      this.idleLifecycleActive = true
      // Mark unloaded at send time: requests are processed serially by the
      // worker, so any later load/transcribe is ordered after the unload and
      // callers must re-load rather than assume the model is still resident.
      this.loaded = false
      void this.request('unload', {}, undefined, true)
        .catch((error) => {
          console.warn('[transcription-worker] Idle unload failed:', error)
        })
        .finally(() => {
          if (!this.idleLifecycleActive || this.disposed || !this.process) {
            return
          }

          this.idleKillTimer = this.setTimeoutFn(
            () => {
              this.idleKillTimer = null
              if (this.disposed || !this.process || this.inFlightRequests > 0) {
                return
              }

              this.idleKilled = true
              this.idleLifecycleActive = false
              this.process.kill()
              this.process = null
              this.loaded = false
            },
            Math.max(0, this.idleKillMs - this.idleUnloadMs)
          )
        })
    }, this.idleUnloadMs)
  }
}
