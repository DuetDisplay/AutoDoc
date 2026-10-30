import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

interface LoadedOllamaManager {
  OllamaManager: typeof import('../ollama-manager').OllamaManager
  spawnMock: Mock
  logAutodocEvent: Mock
  logAutodocFailure: Mock
  markOllamaResumed: typeof import('../ollama-resume').markOllamaResumed
  resetOllamaResumeClock: typeof import('../ollama-resume').resetOllamaResumeClock
  areBackgroundOllamaRestartsPaused: typeof import('../ollama-start-failures').areBackgroundOllamaRestartsPaused
  getOllamaStartFailureStreak: typeof import('../ollama-start-failures').getOllamaStartFailureStreak
  recordOllamaPostWakeCheckFailed: typeof import('../ollama-start-failures').recordOllamaPostWakeCheckFailed
}

function createFakeProcess(pid: number): EventEmitter & {
  pid: number
  stderr: EventEmitter
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: Mock
} {
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & {
    pid: number
    stderr: EventEmitter
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: Mock
  }
  proc.pid = pid
  proc.stderr = stderr
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn(() => {
    proc.exitCode = 1
    proc.emit('exit', 1, null)
    return true
  })
  proc.on('exit', (code: number | null) => {
    if (proc.exitCode == null) {
      proc.exitCode = code
    }
  })
  return proc
}

async function loadOllamaManager(rootDir: string): Promise<LoadedOllamaManager> {
  setPlatform('win32')
  vi.resetModules()
  const spawnMock = vi.fn()
  const logAutodocEvent = vi.fn()
  const logAutodocFailure = vi.fn()
  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn((name: string) => (name === 'appData' ? join(rootDir, 'app-data') : rootDir)),
      isPackaged: false
    }
  }))
  vi.doMock('child_process', () => ({
    spawn: spawnMock,
    execFile: vi.fn(),
    execSync: vi.fn(() => {
      throw new Error('execSync should not run in start lifecycle tests')
    })
  }))
  vi.doMock('../autodoc-log', () => ({
    logAutodocEvent,
    logAutodocFailure
  }))
  const mod = await import('../ollama-manager')
  const resume = await import('../ollama-resume')
  const startFailures = await import('../ollama-start-failures')
  return {
    OllamaManager: mod.OllamaManager,
    spawnMock,
    logAutodocEvent,
    logAutodocFailure,
    markOllamaResumed: resume.markOllamaResumed,
    resetOllamaResumeClock: resume.resetOllamaResumeClock,
    areBackgroundOllamaRestartsPaused: startFailures.areBackgroundOllamaRestartsPaused,
    getOllamaStartFailureStreak: startFailures.getOllamaStartFailureStreak,
    recordOllamaPostWakeCheckFailed: startFailures.recordOllamaPostWakeCheckFailed
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.doUnmock('../autodoc-log')
  vi.resetModules()
  setPlatform(originalPlatform)
})

function serveSpawnCalls(spawnMock: Mock): unknown[][] {
  return spawnMock.mock.calls.filter((call) => {
    const cmd = String(call[0] ?? '')
    const args = (call[1] as string[] | undefined) ?? []
    return cmd !== 'taskkill' && args[0] === 'serve'
  })
}

function taskkillPids(spawnMock: Mock): string[] {
  return spawnMock.mock.calls
    .filter((call) => String(call[0]) === 'taskkill')
    .map((call) => {
      const args = (call[1] as string[]) ?? []
      const pidIndex = args.indexOf('/pid')
      return pidIndex >= 0 ? args[pidIndex + 1] : ''
    })
    .filter(Boolean)
}

function stubStartLifecycle(manager: {
  ensureReady: () => Promise<void>
  isServerRunning: () => Promise<boolean>
}): void {
  vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
  vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
  vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
  vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
  vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
}

function mockServeOrTaskkill(
  spawnMock: Mock,
  serve: () => ReturnType<typeof createFakeProcess>
): void {
  spawnMock.mockImplementation((cmd: string) => {
    if (cmd === 'taskkill') {
      const killer = createFakeProcess(1)
      queueMicrotask(() => {
        killer.exitCode = 0
        killer.emit('exit', 0, null)
      })
      return killer
    }
    return serve()
  })
}

describe('OllamaManager start lifecycle', () => {
  it('latches CPU for the process lifetime', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-latch-'))
    try {
      const { OllamaManager } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test latch')
      expect(manager.getNotesAccelerator()).toBe('cpu')
      expect(
        (manager as unknown as { acceleratorDecision: { env: Record<string, string> } })
          .acceleratorDecision.env
      ).toEqual({ OLLAMA_VULKAN: '0' })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('joins concurrent start() callers on one in-flight serve', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mutex-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      vi.useFakeTimers()
      const first = manager.start({ forceRespawn: true })
      const second = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await Promise.all([first, second])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('classifies a serve that exits loading the model as a non-transient model-load failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-model-load-'))
    try {
      const { OllamaManager, spawnMock, logAutodocFailure } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      const rejected = expect(started).rejects.toMatchObject({
        code: 'OLLAMA_MODEL_LOAD_FAILED',
        message: expect.stringContaining('Ollama exited with code 1')
      })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit(
        'data',
        Buffer.from(
          'error loading model: llama_model_loader: failed to load model from C:\\Users\\Test\\xb3as\\AppData\\Roaming\\AutoDoc\\ollama-data\\blobs\\sha256-85e4\n' +
            'some later unrelated line\n'.repeat(40)
        )
      )
      serveProc.emit('exit', 1, null)
      await rejected

      expect(manager.getModelLoadFailureCount()).toBe(1)
      const failure = logAutodocFailure.mock.calls.find(
        (call) => call[0]?.message === 'ollama server process exited'
      )
      expect(failure?.[0].context).toMatchObject({ modelLoadFailure: true })
      expect(failure?.[0].context.stderrTail).not.toContain('Test')

      manager.clearModelLoadFailures()
      expect(manager.getModelLoadFailureCount()).toBe(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not count an ordinary crash or an app-initiated kill as a model-load failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-crash-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      const rejected = expect(started).rejects.toThrow(/Ollama exited with code 1/)
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('panic: something else went wrong\n'))
      serveProc.emit('exit', 1, null)
      await rejected

      expect(manager.getModelLoadFailureCount()).toBe(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('reuses the same healthy tracked serve on a repeated normal start', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-start-reuse-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      mockServeOrTaskkill(spawnMock, () => serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      const running = vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'getListeningPidsOnOllamaPort').mockReturnValue([4242])

      vi.useFakeTimers()
      const first = manager.start()
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await first

      running.mockResolvedValue(true)
      await manager.start()

      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      expect(taskkillPids(spawnMock)).not.toContain('4242')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('fingerprints an Ollama exit before ready so it does not group with ffmpeg failures', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-exit-fingerprint-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      mockServeOrTaskkill(spawnMock, () => serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const startPromise = manager.start({ forceRespawn: true })
      const captured = startPromise.then(
        () => null,
        (err: Error & { sentryFingerprint?: string[] }) => err
      )
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.exitCode = 2
      serveProc.emit('exit', 2, null)

      const error = await captured
      expect(error?.message).toContain('Ollama exited with code 2')
      expect(error?.sentryFingerprint).toEqual(['ollama-server-exited', '2'])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  describe('starting serve grace', () => {
    async function startReadyManager(): Promise<{
      manager: InstanceType<LoadedOllamaManager['OllamaManager']>
      loaded: LoadedOllamaManager
      serveProc: ReturnType<typeof createFakeProcess>
      health: { up: boolean }
      rootDir: string
    }> {
      const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-starting-'))
      const loaded = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      mockServeOrTaskkill(loaded.spawnMock, () => serveProc)
      const manager = new loaded.OllamaManager()
      manager.latchCpuAccelerator('test')
      const health = { up: false }
      vi.spyOn(manager, 'isServerRunning').mockImplementation(async () => health.up)
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'getListeningPidsOnOllamaPort').mockReturnValue([4242])
      vi.useFakeTimers()
      const first = manager.start()
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await first
      return { manager, loaded, serveProc, health, rootDir }
    }

    /** taskkill kills the old serve (exits it) and later spawns return the replacement. */
    function replaceServeOnKill(
      loaded: LoadedOllamaManager,
      oldProc: ReturnType<typeof createFakeProcess>,
      replacement: ReturnType<typeof createFakeProcess>
    ): void {
      loaded.spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            oldProc.exitCode = 1
            oldProc.emit('exit', 1, null)
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return replacement
      })
    }

    function eventMessages(logAutodocEvent: Mock): string[] {
      return logAutodocEvent.mock.calls.map((call) => String(call[0]?.message))
    }

    it('adopts a ready serve that starts answering within the wait window', async () => {
      const { manager, loaded, health, rootDir } = await startReadyManager()
      try {
        loaded.logAutodocEvent.mockClear()
        expect(manager.isServeStarting()).toBe(true)

        const second = manager.start()
        await vi.advanceTimersByTimeAsync(10_000)
        health.up = true
        await vi.advanceTimersByTimeAsync(2_000)
        await second

        expect(serveSpawnCalls(loaded.spawnMock)).toHaveLength(1)
        expect(taskkillPids(loaded.spawnMock)).not.toContain('4242')
        const messages = eventMessages(loaded.logAutodocEvent)
        expect(messages).toContain('ollama server still starting; waiting before replacing')
        expect(messages).not.toContain('ollama server not adopted; replacing')
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    it('replaces a ready serve that never answers within the wait window', async () => {
      const { manager, loaded, serveProc, rootDir } = await startReadyManager()
      try {
        loaded.logAutodocEvent.mockClear()
        const replacement = createFakeProcess(5252)
        replaceServeOnKill(loaded, serveProc, replacement)

        const second = manager.start()
        await vi.advanceTimersByTimeAsync(31_000)
        // replacement spawn waits for its own Listening line
        await vi.advanceTimersByTimeAsync(2_000)
        replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
        await second

        expect(taskkillPids(loaded.spawnMock)).toContain('4242')
        const notAdopted = loaded.logAutodocEvent.mock.calls.find(
          (call) => call[0]?.message === 'ollama server not adopted; replacing'
        )
        expect(notAdopted?.[0].context).toMatchObject({
          running: false,
          waitedForStart: true
        })
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    it('replaces a serve that became ready more than 60s ago without waiting', async () => {
      const { manager, loaded, serveProc, rootDir } = await startReadyManager()
      try {
        await vi.advanceTimersByTimeAsync(61_000)
        expect(manager.isServeStarting()).toBe(false)
        loaded.logAutodocEvent.mockClear()
        const replacement = createFakeProcess(5252)
        replaceServeOnKill(loaded, serveProc, replacement)

        const second = manager.start()
        await vi.advanceTimersByTimeAsync(1_500)
        replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
        await second

        const messages = eventMessages(loaded.logAutodocEvent)
        expect(messages).not.toContain('ollama server still starting; waiting before replacing')
        const notAdopted = loaded.logAutodocEvent.mock.calls.find(
          (call) => call[0]?.message === 'ollama server not adopted; replacing'
        )
        expect(notAdopted?.[0].context).toMatchObject({ waitedForStart: false })
        expect(taskkillPids(loaded.spawnMock)).toContain('4242')
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    it('does not treat a serve as starting when another process owns the port', async () => {
      const { manager, rootDir } = await startReadyManager()
      try {
        vi.spyOn(manager as never, 'getListeningPidsOnOllamaPort').mockReturnValue([9999])
        expect(manager.isServeStarting()).toBe(false)
        await expect(manager.waitForStartingServe()).resolves.toBe(false)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    it('stops reporting a starting serve once the process has exited', async () => {
      const { manager, serveProc, rootDir } = await startReadyManager()
      try {
        expect(manager.isServeStarting()).toBe(true)
        serveProc.emit('exit', 1, null)
        expect(manager.isServeStarting()).toBe(false)
        await expect(manager.waitForStartingServe()).resolves.toBe(false)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    it('waitForStartingServe returns false when the process exits mid-wait', async () => {
      const { manager, serveProc, rootDir } = await startReadyManager()
      try {
        const waiting = manager.waitForStartingServe()
        await vi.advanceTimersByTimeAsync(1_000)
        serveProc.emit('exit', 1, null)
        await vi.advanceTimersByTimeAsync(2_000)
        await expect(waiting).resolves.toBe(false)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })

    describe('recoverUnhealthyRuntime', () => {
      const STILL_STARTING = 'ollama server still starting; waiting before replacing'

      function stoppedByAppReasons(logAutodocEvent: Mock): unknown[] {
        return logAutodocEvent.mock.calls
          .filter((call) => call[0]?.message === 'ollama server process stopped by app')
          .map((call) => call[0].context?.reason)
      }

      it('keeps a starting serve that answers after about 10s', async () => {
        const { manager, loaded, health, rootDir } = await startReadyManager()
        try {
          loaded.logAutodocEvent.mockClear()
          const recovery = manager.recoverUnhealthyRuntime()
          await vi.advanceTimersByTimeAsync(10_000)
          health.up = true
          await vi.advanceTimersByTimeAsync(2_000)
          await expect(recovery).resolves.toBeUndefined()

          expect(taskkillPids(loaded.spawnMock)).not.toContain('4242')
          expect(serveSpawnCalls(loaded.spawnMock)).toHaveLength(1)
          expect(eventMessages(loaded.logAutodocEvent)).toContain(STILL_STARTING)
          expect(stoppedByAppReasons(loaded.logAutodocEvent)).toEqual([])
        } finally {
          await rm(rootDir, { recursive: true, force: true })
        }
      })

      it('kills and respawns a starting serve that never answers within 30s', async () => {
        const { manager, loaded, serveProc, rootDir } = await startReadyManager()
        try {
          loaded.logAutodocEvent.mockClear()
          const replacement = createFakeProcess(5252)
          replaceServeOnKill(loaded, serveProc, replacement)

          const recovery = manager.recoverUnhealthyRuntime()
          await vi.advanceTimersByTimeAsync(31_000)
          await vi.advanceTimersByTimeAsync(2_000)
          replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
          await recovery

          expect(eventMessages(loaded.logAutodocEvent)).toContain(STILL_STARTING)
          expect(taskkillPids(loaded.spawnMock)).toContain('4242')
          expect(serveSpawnCalls(loaded.spawnMock)).toHaveLength(2)
          expect(stoppedByAppReasons(loaded.logAutodocEvent)).toContain('recover-unhealthy-runtime')
        } finally {
          await rm(rootDir, { recursive: true, force: true })
        }
      })

      it('still replaces a recently ready serve that answers without waiting', async () => {
        const { manager, loaded, serveProc, health, rootDir } = await startReadyManager()
        try {
          health.up = true
          expect(manager.isServeStarting()).toBe(true)
          loaded.logAutodocEvent.mockClear()
          const replacement = createFakeProcess(5252)
          replaceServeOnKill(loaded, serveProc, replacement)

          const recovery = manager.recoverUnhealthyRuntime()
          await vi.advanceTimersByTimeAsync(1_500)
          replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
          await recovery

          expect(eventMessages(loaded.logAutodocEvent)).not.toContain(STILL_STARTING)
          expect(taskkillPids(loaded.spawnMock)).toContain('4242')
          expect(serveSpawnCalls(loaded.spawnMock)).toHaveLength(2)
          expect(stoppedByAppReasons(loaded.logAutodocEvent)).toContain('recover-unhealthy-runtime')
        } finally {
          await rm(rootDir, { recursive: true, force: true })
        }
      })

      it('replaces a non-answering serve that became ready more than 60s ago without waiting', async () => {
        const { manager, loaded, serveProc, rootDir } = await startReadyManager()
        try {
          await vi.advanceTimersByTimeAsync(61_000)
          expect(manager.isServeStarting()).toBe(false)
          loaded.logAutodocEvent.mockClear()
          const replacement = createFakeProcess(5252)
          replaceServeOnKill(loaded, serveProc, replacement)

          const recovery = manager.recoverUnhealthyRuntime()
          await vi.advanceTimersByTimeAsync(1_500)
          replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
          await recovery

          expect(eventMessages(loaded.logAutodocEvent)).not.toContain(STILL_STARTING)
          expect(taskkillPids(loaded.spawnMock)).toContain('4242')
          expect(stoppedByAppReasons(loaded.logAutodocEvent)).toContain('recover-unhealthy-runtime')
        } finally {
          await rm(rootDir, { recursive: true, force: true })
        }
      })
    })

    it('waitForStartingServe returns false when stop() lands mid-wait', async () => {
      const { manager, rootDir } = await startReadyManager()
      try {
        const waiting = manager.waitForStartingServe()
        await vi.advanceTimersByTimeAsync(1_000)
        manager.stop()
        await vi.advanceTimersByTimeAsync(2_000)
        await expect(waiting).resolves.toBe(false)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    })
  })

  it('kills the spawned PID when serve start times out', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-timeout-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return serveProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      vi.useFakeTimers()
      const startPromise = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      const rejected = expect(startPromise).rejects.toThrow(
        'Ollama server failed to start within 30 seconds'
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(taskkillPids(spawnMock)).toContain('4242')
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)
      await rejected
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not null this.process when an old child exits after a newer spawn', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-guard-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const oldProc = createFakeProcess(111)
      const newProc = createFakeProcess(222)
      let serveCount = 0
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        serveCount += 1
        return serveCount === 1 ? oldProc : newProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      vi.useFakeTimers()
      const first = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      oldProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await first

      const second = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(0)
      oldProc.exitCode = 1
      oldProc.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(2)
      oldProc.emit('exit', 1, null)
      expect((manager as unknown as { process: { pid?: number } | null }).process?.pid).toBe(222)

      newProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await second
      expect((manager as unknown as { process: { pid?: number } | null }).process?.pid).toBe(222)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('latches CPU and force-respawns when recovering from a vulkan runner death', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-recover-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const oldProc = createFakeProcess(333)
      const newProc = createFakeProcess(444)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return newProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('pre')
      ;(
        manager as unknown as {
          acceleratorDecision: { accelerator: string; env: Record<string, string>; reason: string }
        }
      ).acceleratorDecision = {
        accelerator: 'vulkan',
        env: { OLLAMA_VULKAN: '1' },
        reason: 'test vulkan'
      }
      ;(manager as unknown as { process: typeof oldProc }).process = oldProc
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const recovered = manager.recoverUnhealthyRuntime()
      await vi.advanceTimersByTimeAsync(0)
      oldProc.exitCode = 1
      oldProc.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(1000)
      newProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await recovered

      expect(manager.getNotesAccelerator()).toBe('cpu')
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not let a stale start finalizer clear a newer recovery startPromise', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stale-finalizer-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const procA = createFakeProcess(111)
      const procB = createFakeProcess(222)
      let serveCount = 0
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        serveCount += 1
        return serveCount === 1 ? procA : procB
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const startA = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)

      const recoverP = manager.recoverUnhealthyRuntime()
      await vi.advanceTimersByTimeAsync(0)
      procA.exitCode = 1
      procA.emit('exit', 1, null)
      await startA.catch(() => {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(2)

      const startC = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(2)

      procB.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await Promise.all([recoverP, startC])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not mark a stale child ready when the process is replaced mid-poll', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stale-poll-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const staleProc = createFakeProcess(111)
      spawnMock.mockReturnValue(staleProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      let release!: (value: boolean) => void
      const gate = new Promise<boolean>((resolve) => {
        release = resolve
      })
      vi.spyOn(manager, 'isServerRunning').mockImplementation(() => gate)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(500)
      ;(manager as unknown as { process: ReturnType<typeof createFakeProcess> }).process =
        createFakeProcess(999)
      release(true)
      await Promise.resolve()
      await Promise.resolve()

      let ready = false
      void started.then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('throws and does not respawn when the old serve cannot be confirmed dead', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-fail-closed-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const orphan = createFakeProcess(777)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return createFakeProcess(888)
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      ;(manager as unknown as { process: typeof orphan }).process = orphan
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const recovered = manager.recoverUnhealthyRuntime()
      const rejected = expect(recovered).rejects.toThrow(/pid 777 did not exit/)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('joins concurrent recoverUnhealthyRuntime callers on one stop/respawn sequence', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-recover-mutex-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const oldProc = createFakeProcess(333)
      const newProc = createFakeProcess(444)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return newProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      ;(manager as unknown as { process: typeof oldProc }).process = oldProc
      vi.spyOn(manager, 'ensureReady').mockResolvedValue(undefined)
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const first = manager.recoverUnhealthyRuntime()
      const second = manager.recoverUnhealthyRuntime()
      expect(second).toBe(first)
      await vi.advanceTimersByTimeAsync(0)
      oldProc.exitCode = 1
      oldProc.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      newProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await Promise.all([first, second])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not spawn a second serve when a start timeout leaves a live orphan', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-orphan-retry-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const orphan = createFakeProcess(4242)
      mockServeOrTaskkill(spawnMock, () => orphan)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const first = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      const firstRejected = expect(first).rejects.toThrow(
        'Ollama server failed to start within 30 seconds'
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await firstRejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)

      const second = manager.start()
      const secondRejected = expect(second).rejects.toThrow(/pid 4242 did not exit/)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await secondRejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('kills a leftover orphan on the next start and spawns exactly once', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-orphan-kill-retry-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const orphan = createFakeProcess(4242)
      const replacement = createFakeProcess(5252)
      let serveCount = 0
      mockServeOrTaskkill(spawnMock, () => {
        serveCount += 1
        return serveCount === 1 ? orphan : replacement
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const first = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      const firstRejected = expect(first).rejects.toThrow(
        'Ollama server failed to start within 30 seconds'
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await firstRejected

      const second = manager.start()
      await vi.advanceTimersByTimeAsync(0)
      orphan.exitCode = 1
      orphan.emit('exit', 1, null)
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(2)
      replacement.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await second
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not spawn after stop() during the pre-spawn window', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-prespawn-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      spawnMock.mockReturnValue(createFakeProcess(4242))

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      let releaseEnsure!: () => void
      vi.spyOn(manager, 'ensureReady').mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseEnsure = () => resolve()
          })
      )
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      const started = manager.start({ forceRespawn: true })
      await Promise.resolve()
      manager.stop()
      releaseEnsure()
      await expect(started).rejects.toThrow('start cancelled by stop()')
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not start after stop() during async preferred-model selection', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-model-select-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      let releaseModel!: () => void
      const manager = new OllamaManager({
        resolveModel: () =>
          new Promise<string>((resolve) => {
            releaseModel = () => resolve('qwen3:4b-instruct')
          })
      })
      stubStartLifecycle(manager)

      const setup = manager.startAndPull()
      await Promise.resolve()
      const rejected = expect(setup).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })

      manager.stop()
      releaseModel()

      await rejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not finish setup after stop() during the optional model pull', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-optional-pull-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      vi.spyOn(manager, 'start').mockResolvedValue(undefined)
      vi.spyOn(
        manager as unknown as { prepareNotesModels(): Promise<void> },
        'prepareNotesModels'
      ).mockResolvedValue(undefined)
      let releaseOptionalPull!: () => void
      const optionalPull = vi
        .spyOn(
          manager as unknown as { pullOptionalEmbeddingModel(): Promise<void> },
          'pullOptionalEmbeddingModel'
        )
        .mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              releaseOptionalPull = resolve
            })
        )
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      const setup = manager.startAndPull()
      await vi.waitFor(() => expect(optionalPull).toHaveBeenCalledTimes(1))
      const rejected = expect(setup).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })

      manager.stop()
      releaseOptionalPull()

      await rejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not begin a stale model pull after stop()', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-before-pull-'))
    try {
      const { OllamaManager } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      let releaseModelCheck!: (installed: boolean) => void
      vi.spyOn(manager, 'hasModel').mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            releaseModelCheck = resolve
          })
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      const epoch = manager.beginSetupLifecycle()
      const pull = manager.pullModel('qwen3:4b-instruct', epoch)
      await Promise.resolve()
      const rejected = expect(pull).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })

      manager.stop()
      releaseModelCheck(false)

      await rejected
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not let a cancelled setup clear a newer ready promise', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-ready-owner-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const modelResolvers: Array<(model: string) => void> = []
      const manager = new OllamaManager({
        resolveModel: () =>
          new Promise<string>((resolve) => {
            modelResolvers.push(resolve)
          })
      })
      stubStartLifecycle(manager)

      const first = manager.startAndPull()
      await Promise.resolve()
      manager.stop()

      const second = manager.startAndPull()
      await Promise.resolve()
      const firstRejected = expect(first).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      modelResolvers[0]('qwen3:4b-instruct')
      await firstRejected

      expect((manager as unknown as { readyPromise: Promise<void> | null }).readyPromise).toBe(
        second
      )

      const secondRejected = expect(second).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      manager.stop()
      modelResolvers[1]('qwen3:4b-instruct')
      await secondRejected
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not let stale model selection clobber a reactivated setup', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stale-model-'))
    try {
      const { OllamaManager } = await loadOllamaManager(rootDir)
      const modelResolvers: Array<(model: string) => void> = []
      const manager = new OllamaManager({
        resolveModel: () =>
          new Promise<string>((resolve) => {
            modelResolvers.push(resolve)
          })
      })
      vi.spyOn(manager, 'start').mockResolvedValue(undefined)
      vi.spyOn(
        manager as unknown as { prepareNotesModels(): Promise<void> },
        'prepareNotesModels'
      ).mockResolvedValue(undefined)
      vi.spyOn(
        manager as unknown as { pullOptionalEmbeddingModel(): Promise<void> },
        'pullOptionalEmbeddingModel'
      ).mockResolvedValue(undefined)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      const staleSetup = manager.startAndPull()
      await Promise.resolve()
      manager.stop()
      const activeSetup = manager.startAndPull()
      await Promise.resolve()

      modelResolvers[1]('qwen3:4b-active')
      await activeSetup
      expect(manager.getModel()).toBe('qwen3:4b-active')

      const staleRejected = expect(staleSetup).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      modelResolvers[0]('qwen3:4b-stale')
      await staleRejected

      expect(manager.getModel()).toBe('qwen3:4b-active')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not respawn when stop() lands during the recovery prelude', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-recovery-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      spawnMock.mockReturnValue(createFakeProcess(4242))

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      let releaseEnsure!: () => void
      vi.spyOn(manager, 'ensureReady').mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseEnsure = () => resolve()
          })
      )
      vi.spyOn(manager, 'isServerRunning').mockResolvedValue(false)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'reapManagedLlamaServersOnce').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      const started = manager.start({ forceRespawn: true })
      await Promise.resolve()
      const recovered = manager.recoverUnhealthyRuntime()
      const startRejected = expect(started).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      const recoveryRejected = expect(recovered).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })

      manager.stop()
      releaseEnsure()

      await Promise.all([startRejected, recoveryRejected])
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('cancels recovery when stop() lands during respawn readiness', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-recovery-ready-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      mockServeOrTaskkill(spawnMock, () => serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const recovered = manager.recoverUnhealthyRuntime()
      const rejected = expect(recovered).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)

      manager.stop()
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)

      await rejected
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('refuses delayed recovery attempts after stop()', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-retry-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()

      manager.stop()

      await expect(manager.recoverUnhealthyRuntime()).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('invalidates tokens captured while stopped when setup is reactivated', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-reactivate-epoch-'))
    try {
      const { OllamaManager } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      manager.stop()
      const stoppedEpoch = manager.captureLifecycleEpoch()
      const activeEpoch = manager.beginSetupLifecycle()

      expect(activeEpoch).toBeGreaterThan(stoppedEpoch)
      expect(() => manager.assertLifecycleEpoch(stoppedEpoch)).toThrow('start cancelled by stop()')
      expect(() => manager.assertLifecycleEpoch(activeEpoch)).not.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not let waitUntilReady() reactivate a stopped manager', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stopped-waiter-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      manager.stop()

      await expect(manager.waitUntilReady()).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      expect(serveSpawnCalls(spawnMock)).toHaveLength(0)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not restart after stop() while checking runner-recycle health', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-runner-health-'))
    try {
      const { OllamaManager } = await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      let releaseHealthCheck!: (running: boolean) => void
      vi.spyOn(manager, 'isServerRunning').mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            releaseHealthCheck = resolve
          })
      )
      const start = vi.spyOn(manager, 'start').mockResolvedValue(undefined)
      vi.spyOn(manager as never, 'killProcessOnPort').mockReturnValue(undefined)
      vi.spyOn(manager as never, 'killManagedLlamaServers').mockReturnValue(undefined)

      const restart = manager.ensureServingAfterRunnerChange('meeting-1')
      const rejected = expect(restart).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
      manager.stop()
      releaseHealthCheck(false)

      await rejected
      expect(start).not.toHaveBeenCalled()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('kills the child when stop() lands after spawn', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stop-postspawn-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      mockServeOrTaskkill(spawnMock, () => serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      expect(serveSpawnCalls(spawnMock)).toHaveLength(1)
      manager.stop()
      expect(taskkillPids(spawnMock)).toContain('4242')
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      expect(
        (manager as unknown as { readyServeProcess: unknown | null }).readyServeProcess
      ).toBeNull()
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)
      await expect(started).rejects.toMatchObject({
        code: 'OLLAMA_START_CANCELLED'
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('rejects promptly when serve exits cleanly before readiness', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-exit-zero-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      const rejected = expect(started).rejects.toThrow(/code 0, signal null/)
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.exitCode = 0
      serveProc.emit('exit', 0, null)
      await rejected
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('rejects promptly when serve exits from a signal before readiness', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-exit-signal-'))
    try {
      const { OllamaManager, spawnMock } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      const rejected = expect(started).rejects.toThrow(/code null, signal SIGTERM/)
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.signalCode = 'SIGTERM'
      serveProc.emit('exit', null, 'SIGTERM')
      await rejected
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('sends a short Sentry message and the full sanitized stderr tail on exit 1', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stderr-tail-'))
    try {
      const { OllamaManager, spawnMock, logAutodocFailure } = await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      const rejected = expect(started).rejects.toThrow(/code 1, signal null/)
      await vi.advanceTimersByTimeAsync(1000)
      const padding = 'gpu listing line\n'.repeat(600)
      const crashLine = 'CUDA error: out of memory during GPU discovery'
      serveProc.stderr.emit('data', Buffer.from(`${padding}${crashLine}\n`))
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)
      await rejected

      expect(logAutodocFailure).toHaveBeenCalledTimes(1)
      const failure = logAutodocFailure.mock.calls[0]?.[0] as {
        error: Error
        context: { stderrTail: string; exitCode: number }
        fingerprint: string[]
      }
      expect(failure.error.message).toBe('Ollama exited with code 1')
      expect(failure.error.message).not.toContain('CUDA error')
      expect(failure.context.exitCode).toBe(1)
      expect(failure.context.stderrTail).toContain(crashLine)
      expect(failure.context.stderrTail.length).toBeLessThanOrEqual(8000)
      expect(failure.fingerprint).toEqual(['ollama-server-exited', '1'])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('records msSinceLastResume on exit after a resume, and null without one', async () => {
    const runExit = async (recordResume: boolean): Promise<number | null> => {
      const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-resume-clock-'))
      try {
        const {
          OllamaManager,
          spawnMock,
          logAutodocFailure,
          markOllamaResumed,
          resetOllamaResumeClock
        } = await loadOllamaManager(rootDir)
        resetOllamaResumeClock()
        const serveProc = createFakeProcess(4242)
        spawnMock.mockReturnValue(serveProc)

        const manager = new OllamaManager()
        manager.latchCpuAccelerator('test')
        stubStartLifecycle(manager)

        vi.useFakeTimers()
        const started = manager.start({ forceRespawn: true })
        const rejected = expect(started).rejects.toThrow(/code 1, signal null/)
        await vi.advanceTimersByTimeAsync(1000)
        if (recordResume) {
          markOllamaResumed()
          await vi.advanceTimersByTimeAsync(2_500)
        }
        serveProc.stderr.emit('data', Buffer.from('ggml_cuda_init: failed during GPU discovery\n'))
        serveProc.exitCode = 1
        serveProc.emit('exit', 1, null)
        await rejected

        const failure = logAutodocFailure.mock.calls[0]?.[0] as {
          context: { msSinceLastResume: number | null }
        }
        return failure.context.msSinceLastResume
      } finally {
        vi.useRealTimers()
        await rm(rootDir, { recursive: true, force: true })
      }
    }

    expect(await runExit(false)).toBeNull()
    expect(await runExit(true)).toBe(2_500)
  })

  it('counts a non-zero exit within 60s of ready as a start failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-early-exit-'))
    try {
      const { OllamaManager, spawnMock, logAutodocFailure, getOllamaStartFailureStreak } =
        await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started
      expect(getOllamaStartFailureStreak()).toBe(0)

      await vi.advanceTimersByTimeAsync(10_000)
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)

      const failure = logAutodocFailure.mock.calls.at(-1)?.[0] as {
        context: { earlyExitAfterReady: boolean; msSinceReady: number | null }
        fingerprint: string[]
      }
      expect(failure.context.earlyExitAfterReady).toBe(true)
      expect(failure.context.msSinceReady).toBe(10_000)
      expect(failure.fingerprint).toEqual(['ollama-server-exited', '1'])
      expect(getOllamaStartFailureStreak()).toBe(1)
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('logs a recovery kill of a fresh serve as stopped by app, not as a crash', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-kill-recover-'))
    try {
      const {
        OllamaManager,
        spawnMock,
        logAutodocEvent,
        logAutodocFailure,
        getOllamaStartFailureStreak
      } = await loadOllamaManager(rootDir)
      const oldProc = createFakeProcess(4242)
      const newProc = createFakeProcess(4343)
      const serves = [oldProc, newProc]
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            // Windows taskkill /f /t makes the killed serve exit with code 1.
            oldProc.exitCode = 1
            oldProc.emit('exit', 1, null)
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return serves.shift()
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)
      vi.spyOn(manager, 'reapLeftoverRunners').mockReturnValue(undefined)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      oldProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started
      await vi.advanceTimersByTimeAsync(10_000)

      const recovered = manager.recoverUnhealthyRuntime()
      await vi.advanceTimersByTimeAsync(1000)
      newProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await recovered

      expect(logAutodocFailure).not.toHaveBeenCalled()
      expect(getOllamaStartFailureStreak()).toBe(0)
      const stopped = logAutodocEvent.mock.calls
        .map((call) => call[0] as { message: string; context: Record<string, unknown> })
        .filter((event) => event.message === 'ollama server process stopped by app')
      expect(stopped).toHaveLength(1)
      expect(stopped[0].context).toMatchObject({
        reason: 'recover-unhealthy-runtime',
        exitCode: 1,
        pid: 4242,
        earlyExitAfterReady: false,
        msSinceReady: 10_000
      })
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('logs stop() of a ready serve as stopped by app with reason stop', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-kill-stop-'))
    try {
      const { OllamaManager, spawnMock, logAutodocEvent, logAutodocFailure } =
        await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            serveProc.exitCode = 1
            serveProc.emit('exit', 1, null)
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return serveProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started
      await vi.advanceTimersByTimeAsync(5_000)

      manager.stop()
      await vi.advanceTimersByTimeAsync(0)

      expect(logAutodocFailure).not.toHaveBeenCalled()
      expect(logAutodocEvent).toHaveBeenCalledWith({
        area: 'ollama',
        message: 'ollama server process stopped by app',
        context: expect.objectContaining({ reason: 'stop', exitCode: 1, pid: 4242 })
      })
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('marks the tracked serve as app-killed before killProcessOnPort can take it out', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-kill-port-'))
    try {
      const { OllamaManager, spawnMock, logAutodocEvent, logAutodocFailure } =
        await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started

      // Isolate the port sweep: the direct kill does nothing, and the sweep (which finds the
      // tracked PID listening on the port) is what makes the serve exit with code 1.
      vi.spyOn(manager as never, 'killProcessAndWait').mockResolvedValue(true as never)
      vi.spyOn(manager as never, 'killProcessOnPort').mockImplementation(() => {
        serveProc.exitCode = 1
        serveProc.emit('exit', 1, null)
      })
      manager.stop()
      await vi.advanceTimersByTimeAsync(0)

      expect(logAutodocFailure).not.toHaveBeenCalled()
      expect(logAutodocEvent).toHaveBeenCalledWith({
        area: 'ollama',
        message: 'ollama server process stopped by app',
        context: expect.objectContaining({ reason: 'stop', exitCode: 1 })
      })
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('logs a tracked serve that is not adopted before replacing it', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-not-adopted-'))
    try {
      const { OllamaManager, spawnMock, logAutodocEvent } = await loadOllamaManager(rootDir)
      const oldProc = createFakeProcess(4242)
      const newProc = createFakeProcess(4343)
      spawnMock.mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') {
          const killer = createFakeProcess(1)
          queueMicrotask(() => {
            oldProc.exitCode = 1
            oldProc.emit('exit', 1, null)
            killer.exitCode = 0
            killer.emit('exit', 0, null)
          })
          return killer
        }
        return newProc
      })

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)
      ;(manager as unknown as { process: typeof oldProc }).process = oldProc
      ;(manager as unknown as { readyServeProcess: typeof oldProc }).readyServeProcess = oldProc

      vi.useFakeTimers()
      // Ready tracked serve, but the server does not answer: running=false, ownsPort=true.
      const started = manager.start()
      await vi.advanceTimersByTimeAsync(1000)
      newProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started

      expect(logAutodocEvent).toHaveBeenCalledWith({
        area: 'ollama',
        message: 'ollama server not adopted; replacing',
        context: {
          pid: 4242,
          forceRespawn: false,
          isReadyServeProcess: true,
          running: false,
          ownsPort: expect.any(Boolean),
          waitedForStart: false
        }
      })
      const spawnEvent = logAutodocEvent.mock.calls
        .map((call) => call[0] as { message: string; context: Record<string, unknown> })
        .find((event) => event.message === 'ollama server spawn attempt')
      expect(spawnEvent?.context).toMatchObject({ pid: 4343 })
      expect(typeof spawnEvent?.context.modelsDir).toBe('string')
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not count a non-zero exit 2 minutes after ready as a start failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-late-exit-'))
    try {
      const { OllamaManager, spawnMock, logAutodocFailure, getOllamaStartFailureStreak } =
        await loadOllamaManager(rootDir)
      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)

      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started

      await vi.advanceTimersByTimeAsync(120_000)
      serveProc.exitCode = 1
      serveProc.emit('exit', 1, null)

      const failure = logAutodocFailure.mock.calls.at(-1)?.[0] as {
        context: { earlyExitAfterReady: boolean; msSinceReady: number | null }
      }
      expect(failure.context.earlyExitAfterReady).toBe(false)
      expect(failure.context.msSinceReady).toBe(120_000)
      expect(getOllamaStartFailureStreak()).toBe(0)
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('clears the wake pause only after a serve stays ready for 60s', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-serve-stable-'))
    try {
      const {
        OllamaManager,
        spawnMock,
        areBackgroundOllamaRestartsPaused,
        recordOllamaPostWakeCheckFailed
      } = await loadOllamaManager(rootDir)
      for (let i = 0; i < 3; i++) {
        recordOllamaPostWakeCheckFailed()
      }
      expect(areBackgroundOllamaRestartsPaused()).toBe(true)

      const serveProc = createFakeProcess(4242)
      spawnMock.mockReturnValue(serveProc)
      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      vi.useFakeTimers()
      const started = manager.start({ forceRespawn: true })
      await vi.advanceTimersByTimeAsync(1000)
      serveProc.stderr.emit('data', Buffer.from('Listening on 127.0.0.1:11435\n'))
      await started
      expect(areBackgroundOllamaRestartsPaused()).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(areBackgroundOllamaRestartsPaused()).toBe(false)
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not pause background restarts after five consecutive start() failures', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-start-cap-'))
    try {
      const { OllamaManager, spawnMock, logAutodocEvent, areBackgroundOllamaRestartsPaused } =
        await loadOllamaManager(rootDir)
      const manager = new OllamaManager()
      manager.latchCpuAccelerator('test')
      stubStartLifecycle(manager)

      for (let i = 0; i < 5; i++) {
        const serveProc = createFakeProcess(4300 + i)
        spawnMock.mockReturnValue(serveProc)
        vi.useFakeTimers()
        const started = manager.start({ forceRespawn: true })
        const rejected = expect(started).rejects.toThrow(/code 1, signal null/)
        await vi.advanceTimersByTimeAsync(1000)
        serveProc.stderr.emit('data', Buffer.from('ggml_cuda_init: failed during GPU discovery\n'))
        serveProc.exitCode = 1
        serveProc.emit('exit', 1, null)
        await rejected
        vi.useRealTimers()
      }

      expect(areBackgroundOllamaRestartsPaused()).toBe(false)
      expect(logAutodocEvent).not.toHaveBeenCalledWith({
        area: 'ollama',
        message: 'ollama restarts paused after repeated start failures'
      })
    } finally {
      vi.useRealTimers()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
