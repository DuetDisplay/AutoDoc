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
  const mod = await import('../ollama-manager')
  return { OllamaManager: mod.OllamaManager, spawnMock }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
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
})
