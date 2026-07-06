import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { TranscriptionWorkerClient } from '../transcription-worker-client'

class MockStdin extends EventEmitter {
  destroyed = false
  writeCalls: string[] = []

  write(chunk: string): boolean {
    this.writeCalls.push(chunk)
    return true
  }
}

class MockChildProcess extends EventEmitter {
  pid = 4242
  stdin = new MockStdin()
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('close', null, 'SIGTERM')
    return true
  }
}

describe('TranscriptionWorkerClient', () => {
  let mockProcess: MockChildProcess
  let spawnFn: ReturnType<typeof vi.fn>
  let scheduledTimeouts: Array<{ delay: number; callback: () => void }>
  let setTimeoutFn: typeof setTimeout
  let clearTimeoutFn: typeof clearTimeout

  beforeEach(() => {
    mockProcess = new MockChildProcess()
    spawnFn = vi.fn(() => {
      mockProcess.killed = false
      return mockProcess as any
    })
    scheduledTimeouts = []
    setTimeoutFn = ((callback: () => void, delay?: number) => {
      scheduledTimeouts.push({ delay: delay ?? 0, callback })
      return scheduledTimeouts.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    clearTimeoutFn = vi.fn() as typeof clearTimeout
  })

  function createClient(
    overrides: Partial<ConstructorParameters<typeof TranscriptionWorkerClient>[0]> = {}
  ) {
    return new TranscriptionWorkerClient({
      pythonPath: '/mock/python.exe',
      scriptPath: '/mock/transcription-worker.py',
      processEnv: { PATH: '/mock/path' },
      spawnFn,
      idleUnloadMs: 1000,
      idleKillMs: 2000,
      setTimeoutFn,
      clearTimeoutFn,
      ...overrides
    })
  }

  function pushStdout(payload: unknown): void {
    mockProcess.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`))
  }

  function parseLastRequest(): Record<string, unknown> {
    const lastWrite = mockProcess.stdin.writeCalls.at(-1) ?? ''
    return JSON.parse(lastWrite.trim()) as Record<string, unknown>
  }

  async function waitForRequestCount(count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(mockProcess.stdin.writeCalls.length).toBeGreaterThanOrEqual(count)
    })
  }

  it('correlates request/response pairs with out-of-order ids', async () => {
    const client = createClient()
    const first = client.ping()
    await waitForRequestCount(1)
    const second = client.ping()
    await waitForRequestCount(2)

    const firstId = JSON.parse(mockProcess.stdin.writeCalls[0].trim()).id as number
    const secondId = JSON.parse(mockProcess.stdin.writeCalls[1].trim()).id as number

    pushStdout({ id: secondId, ok: true, result: { pong: true } })
    pushStdout({ id: firstId, ok: true, result: { pong: true } })

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('routes segment events to the matching transcribe callback', async () => {
    const client = createClient()
    const segments: Array<{ startMs: number; endMs: number; text: string }> = []
    const transcribePromise = client.transcribe(
      { audio: '/mock/audio.wav', language: 'en', window: null },
      (event) => {
        segments.push({ startMs: event.startMs, endMs: event.endMs, text: event.text })
      }
    )
    await waitForRequestCount(1)

    const requestId = parseLastRequest().id as number
    pushStdout({ event: 'segment', id: requestId, startMs: 0, endMs: 500, text: 'hello' })
    pushStdout({
      id: requestId,
      ok: true,
      result: { transcription: [{ offsets: { from: 0, to: 500 }, text: 'hello' }] }
    })

    await expect(transcribePromise).resolves.toEqual({
      transcription: [{ offsets: { from: 0, to: 500 }, text: 'hello' }]
    })
    expect(segments).toEqual([{ startMs: 0, endMs: 500, text: 'hello' }])
  })

  it('buffers partial stdout lines across chunks', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    const requestId = parseLastRequest().id as number
    const payload = JSON.stringify({ id: requestId, ok: true, result: { pong: true } })

    mockProcess.stdout.emit('data', Buffer.from(payload.slice(0, 10)))
    mockProcess.stdout.emit('data', Buffer.from(`${payload.slice(10)}\n`))

    await expect(pingPromise).resolves.toBeUndefined()
  })

  it('rejects in-flight requests on crash, respawns once, then surfaces repeated crashes', async () => {
    const client = createClient()

    const firstPing = client.ping()
    await waitForRequestCount(1)
    mockProcess.emit('close', 1)
    await expect(firstPing).rejects.toThrow(/exited with code 1/)

    const respawnPing = client.ping()
    await waitForRequestCount(2)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    mockProcess.emit('close', 1)
    await expect(respawnPing).rejects.toThrow(/exited with code 1/)

    await expect(client.ping()).rejects.toThrow(/crashed repeatedly/)
    expect(spawnFn).toHaveBeenCalledTimes(2)
  }, 10000)

  it('sends idle unload then kills the process after the kill window', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    expect(scheduledTimeouts).toHaveLength(1)
    scheduledTimeouts[0].callback()
    await waitForRequestCount(2)

    expect(parseLastRequest().op).toBe('unload')
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { loaded: false } })
    await vi.waitFor(() => {
      expect(client.isLoaded).toBe(false)
      expect(scheduledTimeouts).toHaveLength(2)
    })

    scheduledTimeouts[1].callback()
    expect(mockProcess.killed).toBe(true)
  })

  it('respawns cleanly after idle kill when a new request arrives', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    scheduledTimeouts[0].callback()
    await waitForRequestCount(2)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { loaded: false } })
    await vi.waitFor(() => {
      expect(client.isLoaded).toBe(false)
      expect(scheduledTimeouts).toHaveLength(2)
    })
    scheduledTimeouts[1].callback()
    expect(mockProcess.killed).toBe(true)

    const writesBeforeRespawn = mockProcess.stdin.writeCalls.length
    const afterIdlePing = client.ping()
    await vi.waitFor(() => {
      expect(mockProcess.stdin.writeCalls.length).toBeGreaterThan(writesBeforeRespawn)
    })
    expect(spawnFn).toHaveBeenCalledTimes(2)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await expect(afterIdlePing).resolves.toBeUndefined()
  })

  it('re-arms the idle lifecycle after a request interrupts an idle unload', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    // Fire the idle unload timer and complete the unload.
    expect(scheduledTimeouts).toHaveLength(1)
    scheduledTimeouts[0].callback()
    await waitForRequestCount(2)
    expect(parseLastRequest().op).toBe('unload')
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { loaded: false } })
    await vi.waitFor(() => {
      expect(scheduledTimeouts).toHaveLength(2)
    })

    // A new request arrives before the idle kill fires.
    const timersBefore = scheduledTimeouts.length
    const revivedPing = client.ping()
    await waitForRequestCount(3)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await revivedPing

    // The idle unload timer must be re-armed for the next quiet period.
    expect(scheduledTimeouts.length).toBeGreaterThan(timersBefore)
    const rearmed = scheduledTimeouts.at(-1)!
    rearmed.callback()
    await waitForRequestCount(4)
    expect(parseLastRequest().op).toBe('unload')
  })

  it('does not consume the crash-respawn budget for idle-kill respawns', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    // Idle unload, then idle kill.
    scheduledTimeouts[0].callback()
    await waitForRequestCount(2)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { loaded: false } })
    await vi.waitFor(() => {
      expect(scheduledTimeouts).toHaveLength(2)
    })
    scheduledTimeouts[1].callback()
    expect(mockProcess.killed).toBe(true)

    // Respawn after idle kill, then crash once: the crash respawn must still work.
    const afterIdlePing = client.ping()
    await waitForRequestCount(3)
    expect(spawnFn).toHaveBeenCalledTimes(2)
    mockProcess.emit('close', 1)
    await expect(afterIdlePing).rejects.toThrow(/exited with code 1/)

    const crashRespawnPing = client.ping()
    await waitForRequestCount(4)
    expect(spawnFn).toHaveBeenCalledTimes(3)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await expect(crashRespawnPing).resolves.toBeUndefined()
  })

  it('dispose kills the process and clears timers', async () => {
    const client = createClient()
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    client.dispose()
    expect(mockProcess.killed).toBe(true)
    expect(clearTimeoutFn).toHaveBeenCalled()
    await expect(client.ping()).rejects.toThrow(/disposed/)
  })

  it('passes extra args such as --no-eco to spawn', async () => {
    const client = createClient({ extraArgs: ['--no-eco'] })
    const pingPromise = client.ping()
    await waitForRequestCount(1)
    pushStdout({ id: parseLastRequest().id as number, ok: true, result: { pong: true } })
    await pingPromise

    expect(spawnFn).toHaveBeenCalledWith(
      '/mock/python.exe',
      ['/mock/transcription-worker.py', '--no-eco'],
      expect.any(Object)
    )
  })
})
