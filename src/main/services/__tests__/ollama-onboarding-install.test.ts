import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { Writable } from 'stream'
import { LOW_SPEC_MAC_OLLAMA_MODEL } from '../../../shared/constants'

const originalPlatform = process.platform
const originalTestUserDataDir = process.env.AUTODOC_TEST_USER_DATA_DIR

interface LoadedOllamaManager {
  OllamaManager: typeof import('../ollama-manager').OllamaManager
  clearDownloadedComponents: typeof import('../storage-manager').clearDownloadedComponents
  execSyncMock: Mock
  execFileMock: Mock
  spawnMock: Mock
}

interface OllamaManagerPrivateAccess {
  getOllamaDataDir(): string
  downloadToFile(url: string, destPath: string, signal: AbortSignal): Promise<void>
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

async function loadOllamaManager(
  platform: 'darwin' | 'win32',
  rootDir: string,
  isPackaged = false,
  createWriteStreamMock?: Mock
): Promise<LoadedOllamaManager> {
  setPlatform(platform)
  vi.resetModules()

  const execSyncMock = vi.fn()
  const spawnMock = vi.fn()
  const execFileMock = vi.fn()

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn((name: string) => (name === 'appData' ? join(rootDir, 'app-data') : rootDir)),
      isPackaged: isPackaged
    }
  }))

  vi.doMock('child_process', () => ({
    spawn: spawnMock,
    execFile: execFileMock,
    execSync: execSyncMock
  }))
  if (createWriteStreamMock) {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs')
      return {
        ...actual,
        createWriteStream: createWriteStreamMock
      }
    })
  } else {
    vi.doUnmock('fs')
  }

  const mod = await import('../ollama-manager')
  const storageMod = await import('../storage-manager')
  return {
    OllamaManager: mod.OllamaManager,
    clearDownloadedComponents: storageMod.clearDownloadedComponents,
    execSyncMock,
    execFileMock,
    spawnMock
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.doUnmock('fs')
  vi.resetModules()
  if (originalTestUserDataDir == null) {
    delete process.env.AUTODOC_TEST_USER_DATA_DIR
  } else {
    process.env.AUTODOC_TEST_USER_DATA_DIR = originalTestUserDataDir
  }
  setPlatform(originalPlatform)
})

describe('Ollama onboarding dependency installation', () => {
  it('owns an immediate destination stream error and removes the partial archive', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-stream-error-'))
    const createWriteStreamMock = vi.fn(() => {
      const sink = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        }
      })
      process.nextTick(() => {
        const error = Object.assign(new Error('destination disappeared'), { code: 'ENOENT' })
        sink.destroy(error)
      })
      return sink
    })

    try {
      const { OllamaManager } = await loadOllamaManager(
        'darwin',
        rootDir,
        true,
        createWriteStreamMock
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      )
      const manager = new OllamaManager()

      const setupError = await manager.ensureReady().then(
        () => null,
        (error: Error) => error
      )

      expect(setupError?.message).toBe('Failed to install managed Ollama runtime (ENOENT)')
      expect(setupError?.message).not.toContain(rootDir)
      expect(createWriteStreamMock).toHaveBeenCalledTimes(1)
      expect(await readdir(join(rootDir, 'models'))).toEqual(['ollama-runtime'])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('waits for download backpressure before resolving', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-backpressure-'))
    const chunksWritten: Buffer[] = []
    let activeWrites = 0
    let maxActiveWrites = 0
    const createWriteStreamMock = vi.fn(
      () =>
        new Writable({
          highWaterMark: 1,
          write(chunk: Buffer, _encoding, callback) {
            activeWrites += 1
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
            setTimeout(() => {
              chunksWritten.push(Buffer.from(chunk))
              activeWrites -= 1
              callback()
            }, 5)
          }
        })
    )

    try {
      const { OllamaManager } = await loadOllamaManager(
        'darwin',
        rootDir,
        true,
        createWriteStreamMock
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1, 2]))
                  controller.enqueue(new Uint8Array([3, 4]))
                  controller.enqueue(new Uint8Array([5, 6]))
                  controller.close()
                }
              }),
              { status: 200 }
            )
        )
      )
      const manager = new OllamaManager()

      await (manager as unknown as OllamaManagerPrivateAccess).downloadToFile(
        'https://example.invalid/ollama.tgz',
        join(rootDir, 'runtime', 'ollama-darwin.tgz'),
        new AbortController().signal
      )

      expect(maxActiveWrites).toBe(1)
      expect(Buffer.concat(chunksWritten)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not create an archive when the download response has no body', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-no-body-'))
    const archivePath = join(rootDir, 'runtime', 'ollama-darwin.tgz')

    try {
      const { OllamaManager } = await loadOllamaManager('darwin', rootDir, true)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 }))
      )
      const manager = new OllamaManager()

      await expect(
        (manager as unknown as OllamaManagerPrivateAccess).downloadToFile(
          'https://example.invalid/ollama.tgz',
          archivePath,
          new AbortController().signal
        )
      ).rejects.toThrow('No response body')
      await expect(access(archivePath)).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not create an archive when the download request fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-http-error-'))
    const archivePath = join(rootDir, 'runtime', 'ollama-darwin.tgz')

    try {
      const { OllamaManager } = await loadOllamaManager('darwin', rootDir, true)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 503, statusText: 'Unavailable' }))
      )
      const manager = new OllamaManager()

      await expect(
        (manager as unknown as OllamaManagerPrivateAccess).downloadToFile(
          'https://example.invalid/ollama.tgz',
          archivePath,
          new AbortController().signal
        )
      ).rejects.toThrow('503')
      await expect(access(archivePath)).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('removes a partial archive after a mid-stream download failure', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-midstream-'))
    const archivePath = join(rootDir, 'runtime', 'ollama-darwin.tgz')

    try {
      const { OllamaManager } = await loadOllamaManager('darwin', rootDir, true)
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([1, 2, 3]))
                  controller.error(new Error('connection interrupted'))
                }
              }),
              { status: 200 }
            )
        )
      )
      const manager = new OllamaManager()

      await expect(
        (manager as unknown as OllamaManagerPrivateAccess).downloadToFile(
          'https://example.invalid/ollama.tgz',
          archivePath,
          new AbortController().signal
        )
      ).rejects.toThrow('connection interrupted')
      await expect(access(archivePath)).rejects.toThrow()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps one setup owner and blocks restart until cancellation has joined', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-cancel-'))

    try {
      const { OllamaManager } = await loadOllamaManager('darwin', rootDir, true)
      const manager = new OllamaManager()
      let releaseStart!: () => void
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve
      })
      const startSpy = vi
        .spyOn(manager, 'start')
        .mockImplementationOnce(() => startGate)
        .mockResolvedValueOnce(undefined)
      vi.spyOn(manager, 'pullModel').mockResolvedValue(undefined)

      const firstAttempt = manager.startAndPull()
      await Promise.resolve()
      expect(startSpy).toHaveBeenCalledTimes(1)
      manager.resetReady()
      expect(manager.startAndPull()).toBe(firstAttempt)

      const cancellation = manager.cancelSetup()
      await expect(manager.startAndPull()).rejects.toHaveProperty(
        'name',
        'OllamaSetupCancelledError'
      )

      releaseStart()
      await expect(firstAttempt).rejects.toHaveProperty('name', 'OllamaSetupCancelledError')
      await cancellation

      manager.resumeSetup()
      await expect(manager.startAndPull()).resolves.toBeUndefined()
      expect(startSpy).toHaveBeenCalledTimes(2)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('cancels an active download and leaves no staging work before managed files are cleared', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-clear-race-'))
    let downloadAborted = false
    let markDownloadStarted!: () => void
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve
    })

    try {
      const { OllamaManager, clearDownloadedComponents, execSyncMock } = await loadOllamaManager(
        'darwin',
        rootDir,
        true
      )
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (_url: string | URL | Request, init?: RequestInit) =>
            await new Promise<Response>((_resolve, reject) => {
              markDownloadStarted()
              init?.signal?.addEventListener(
                'abort',
                () => {
                  downloadAborted = true
                  reject(new DOMException('aborted', 'AbortError'))
                },
                { once: true }
              )
            })
        )
      )

      const manager = new OllamaManager()
      const setupAttempt = manager.startAndPull()
      await downloadStarted

      await manager.cancelSetup()
      await expect(setupAttempt).rejects.toHaveProperty('name', 'OllamaSetupCancelledError')
      await clearDownloadedComponents()

      expect(downloadAborted).toBe(true)
      await expect(access(join(rootDir, 'models'))).rejects.toThrow()
      manager.resumeSetup()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs a packaged macOS runtime binary and waits for startup plus model pull before resolving', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mac-'))

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir, true)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new OllamaManager()
      const statuses: string[] = []
      manager.on('download-start', () => statuses.push('download-start'))
      manager.on('download-complete', () => statuses.push('download-complete'))
      manager.on('pull-start', () => statuses.push('pull-start'))
      manager.on('pull-complete', () => statuses.push('pull-complete'))

      vi.spyOn(manager as never, 'downloadBinary').mockImplementation(async () => {
        manager.emit('download-start', 'ollama')
        const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
        await mkdir(runtimeDir, { recursive: true })
        await writeFile(join(runtimeDir, 'ollama'), 'binary')
        await writeFile(join(runtimeDir, 'llama-server'), 'binary')
        manager.emit('download-complete', 'ollama')
      })

      vi.spyOn(manager, 'start').mockImplementation(async () => {
        await manager.ensureReady()
        const dataDir = join(rootDir, 'ollama-data')
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'serve-ready.txt'), 'ready')
      })

      vi.spyOn(manager, 'pullModel').mockImplementation(async () => {
        manager.emit('pull-start', manager.getModel())
        const dataDir = join(rootDir, 'ollama-data')
        await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())
        manager.emit('pull-complete', manager.getModel())
      })

      await manager.startAndPull()

      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'ollama'))
      ).resolves.toBeUndefined()
      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'llama-server'))
      ).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data', 'serve-ready.txt'))).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data', 'model-ready.txt'))).resolves.toBeUndefined()
      await expect(
        readFile(join(rootDir, 'ollama-data', 'model-ready.txt'), 'utf-8')
      ).resolves.toContain(manager.getModel())
      expect(execSyncMock).not.toHaveBeenCalled()
      expect(statuses).toEqual([
        'download-start',
        'download-complete',
        'pull-start',
        'pull-complete'
      ])
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('extracts the complete macOS Ollama runtime archive including llama-server', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mac-extract-'))

    try {
      const { OllamaManager, execFileMock, execSyncMock } = await loadOllamaManager(
        'darwin',
        rootDir,
        true
      )
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      )

      execFileMock.mockImplementation(
        (
          command: string,
          args: string[],
          _options: unknown,
          callback: (err: Error | null) => void
        ) => {
          expect(command).toBe('tar')
          expect(args[0]).toBe('xzf')
          expect(args[1]).toMatch(
            new RegExp(
              `^${join(rootDir, 'models', '.ollama-runtime-staging-').replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
              )}`
            )
          )
          expect(args[2]).toBe('-C')
          expect(args[3]).toBe(join(args[1], '..'))
          const extractionProcess = { kill: vi.fn() }
          void Promise.all([
            writeFile(join(args[3], 'ollama'), 'binary'),
            writeFile(join(args[3], 'llama-server'), 'binary')
          ]).then(
            () => callback(null),
            (error: Error) => callback(error)
          )
          return extractionProcess
        }
      )

      const manager = new OllamaManager()
      await manager.ensureReady()

      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'ollama'))
      ).resolves.toBeUndefined()
      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'llama-server'))
      ).resolves.toBeUndefined()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('treats a packaged macOS runtime without llama-server as not ready', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mac-missing-sidecar-'))

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir, true)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
      await mkdir(runtimeDir, { recursive: true })
      await writeFile(join(runtimeDir, 'ollama'), 'binary')

      const manager = new OllamaManager()
      await expect(manager.isReady()).resolves.toBe(false)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('allows macOS dev builds to adopt a system runtime', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-dev-mac-'))
    const systemBinary = join(rootDir, 'system-ollama')
    await writeFile(systemBinary, 'binary')

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir)
      execSyncMock.mockReturnValue(systemBinary)

      const manager = new OllamaManager()
      await manager.ensureReady()

      expect(execSyncMock).toHaveBeenCalled()
      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'ollama'))
      ).resolves.toBeUndefined()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'marks copied macOS installed runtime sidecars executable',
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-dev-mac-sidecar-'))
      const installedRuntimeDir = join(rootDir, 'app-data', 'AutoDoc', 'models', 'ollama-runtime')
      const runtimeDir = join(rootDir, 'models', 'ollama-runtime')

      try {
        delete process.env.AUTODOC_TEST_USER_DATA_DIR
        await mkdir(installedRuntimeDir, { recursive: true })
        await writeFile(join(installedRuntimeDir, 'ollama'), 'binary')
        await writeFile(join(installedRuntimeDir, 'llama-server'), 'binary')
        await chmod(join(installedRuntimeDir, 'ollama'), 0o644)
        await chmod(join(installedRuntimeDir, 'llama-server'), 0o644)

        const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir)
        execSyncMock.mockImplementation(() => {
          throw new Error('system lookup should not be needed when installed assets exist')
        })

        const manager = new OllamaManager()
        await manager.ensureReady()

        const ollamaMode = (await stat(join(runtimeDir, 'ollama'))).mode
        const llamaServerMode = (await stat(join(runtimeDir, 'llama-server'))).mode
        expect(ollamaMode & 0o111).not.toBe(0)
        expect(llamaServerMode & 0o111).not.toBe(0)
        await expect(manager.isReady()).resolves.toBe(true)
      } finally {
        await rm(rootDir, { recursive: true, force: true })
      }
    }
  )

  it('selects the low-spec Mac notes model before onboarding pulls the model', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-low-spec-mac-'))

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir, true)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new OllamaManager({ resolveModel: () => LOW_SPEC_MAC_OLLAMA_MODEL })
      const selectedModels: string[] = []
      manager.on('model-selected', (model: string) => selectedModels.push(model))

      vi.spyOn(manager, 'start').mockImplementation(async () => {
        const dataDir = join(rootDir, 'ollama-data')
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'serve-ready.txt'), 'ready')
      })

      vi.spyOn(manager, 'pullModel').mockImplementation(async () => {
        const dataDir = join(rootDir, 'ollama-data')
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())
      })

      await manager.startAndPull()

      expect(selectedModels).toEqual([LOW_SPEC_MAC_OLLAMA_MODEL])
      expect(manager.getModel()).toBe(LOW_SPEC_MAC_OLLAMA_MODEL)
      await expect(
        readFile(join(rootDir, 'ollama-data', 'model-ready.txt'), 'utf-8')
      ).resolves.toBe(LOW_SPEC_MAC_OLLAMA_MODEL)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('requests the low-spec Mac notes model from the managed Ollama pull API', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-low-spec-pull-'))
    const pulledModels: string[] = []

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir, true)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const href = String(url)
          if (href.endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
          }

          if (href.endsWith('/api/pull')) {
            const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
            pulledModels.push(body.name ?? '')
            return new Response(
              new ReadableStream({
                start(controller) {
                  const encoder = new TextEncoder()
                  controller.enqueue(
                    encoder.encode(
                      JSON.stringify({
                        status: 'pulling manifest',
                        total: 100,
                        completed: 100
                      }) + '\n'
                    )
                  )
                  controller.enqueue(encoder.encode(JSON.stringify({ status: 'success' }) + '\n'))
                  controller.close()
                }
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/x-ndjson' }
              }
            )
          }

          return new Response(null, { status: 404 })
        })
      )

      const manager = new OllamaManager({ resolveModel: () => LOW_SPEC_MAC_OLLAMA_MODEL })
      vi.spyOn(manager, 'start').mockResolvedValue(undefined)

      await manager.startAndPull()

      expect(pulledModels).toEqual([LOW_SPEC_MAC_OLLAMA_MODEL])
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('reuses the installed app runtime and model store in dev builds', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-dev-reuse-'))
    const installedRuntimeDir = join(rootDir, 'app-data', 'AutoDoc', 'models', 'ollama-runtime')
    const installedDataDir = join(rootDir, 'app-data', 'AutoDoc', 'ollama-data')

    try {
      delete process.env.AUTODOC_TEST_USER_DATA_DIR
      await mkdir(installedRuntimeDir, { recursive: true })
      await mkdir(installedDataDir, { recursive: true })
      await writeFile(join(installedRuntimeDir, 'ollama.exe'), 'binary')
      await writeFile(join(installedDataDir, 'model-ready.txt'), 'llama3.1')

      const { OllamaManager, execSyncMock } = await loadOllamaManager('win32', rootDir)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be needed when installed assets exist')
      })

      const manager = new OllamaManager()
      const downloadBinarySpy = vi.spyOn(manager as never, 'downloadBinary')

      await manager.ensureReady()

      expect(downloadBinarySpy).not.toHaveBeenCalled()
      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'ollama.exe'))
      ).resolves.toBeUndefined()
      expect((manager as unknown as OllamaManagerPrivateAccess).getOllamaDataDir()).toBe(
        installedDataDir
      )
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs a packaged Windows runtime binary before startup continues', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-win-'))

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('win32', rootDir, true)
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new OllamaManager()

      vi.spyOn(manager as never, 'downloadBinary').mockImplementation(async () => {
        const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
        await mkdir(runtimeDir, { recursive: true })
        await writeFile(join(runtimeDir, 'ollama.exe'), 'binary')
      })

      await manager.ensureReady()

      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(
        access(join(rootDir, 'models', 'ollama-runtime', 'ollama.exe'))
      ).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data'))).resolves.toBeUndefined()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('restarts packaged macOS Ollama setup after downloaded components are cleared', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mac-recovery-'))

    try {
      const { OllamaManager, clearDownloadedComponents, execSyncMock } = await loadOllamaManager(
        'darwin',
        rootDir,
        true
      )
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new OllamaManager()
      const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
      const dataDir = join(rootDir, 'ollama-data')
      await mkdir(runtimeDir, { recursive: true })
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(runtimeDir, 'ollama'), 'binary')
      await writeFile(join(runtimeDir, 'llama-server'), 'binary')
      await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())

      await expect(manager.isReady()).resolves.toBe(true)

      await clearDownloadedComponents()
      await expect(access(join(runtimeDir, 'ollama'))).rejects.toThrow()
      await expect(access(join(dataDir, 'model-ready.txt'))).rejects.toThrow()
      await expect(manager.isReady()).resolves.toBe(false)

      const downloadBinarySpy = vi
        .spyOn(manager as never, 'downloadBinary')
        .mockImplementation(async () => {
          await mkdir(runtimeDir, { recursive: true })
          await writeFile(join(runtimeDir, 'ollama'), 'binary')
          await writeFile(join(runtimeDir, 'llama-server'), 'binary')
        })
      const startSpy = vi.spyOn(manager, 'start').mockImplementation(async () => {
        await manager.ensureReady()
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'serve-ready.txt'), 'ready')
      })
      const pullSpy = vi.spyOn(manager, 'pullModel').mockImplementation(async () => {
        manager.emit('pull-start', manager.getModel())
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())
        manager.emit('pull-complete', manager.getModel())
      })

      manager.resetReady()
      await manager.waitUntilReady()

      expect(downloadBinarySpy).toHaveBeenCalledTimes(1)
      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(pullSpy).toHaveBeenCalledTimes(1)
      await expect(access(join(runtimeDir, 'ollama'))).resolves.toBeUndefined()
      await expect(access(join(runtimeDir, 'llama-server'))).resolves.toBeUndefined()
      await expect(access(join(dataDir, 'serve-ready.txt'))).resolves.toBeUndefined()
      await expect(access(join(dataDir, 'model-ready.txt'))).resolves.toBeUndefined()
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('restarts packaged Windows Ollama setup after downloaded components are cleared', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-win-recovery-'))

    try {
      const { OllamaManager, clearDownloadedComponents, execSyncMock } = await loadOllamaManager(
        'win32',
        rootDir,
        true
      )
      execSyncMock.mockImplementation(() => {
        throw new Error('system lookup should not be used in packaged mode')
      })

      const manager = new OllamaManager()
      const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
      const dataDir = join(rootDir, 'ollama-data')
      await mkdir(runtimeDir, { recursive: true })
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(runtimeDir, 'ollama.exe'), 'binary')
      await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())

      await expect(manager.isReady()).resolves.toBe(true)

      await clearDownloadedComponents()
      await expect(access(join(runtimeDir, 'ollama.exe'))).rejects.toThrow()
      await expect(access(join(dataDir, 'model-ready.txt'))).rejects.toThrow()
      await expect(manager.isReady()).resolves.toBe(false)

      const downloadBinarySpy = vi
        .spyOn(manager as never, 'downloadBinary')
        .mockImplementation(async () => {
          await mkdir(runtimeDir, { recursive: true })
          await writeFile(join(runtimeDir, 'ollama.exe'), 'binary')
        })
      const startSpy = vi.spyOn(manager, 'start').mockImplementation(async () => {
        await manager.ensureReady()
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'serve-ready.txt'), 'ready')
      })
      const pullSpy = vi.spyOn(manager, 'pullModel').mockImplementation(async () => {
        manager.emit('pull-start', manager.getModel())
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'model-ready.txt'), manager.getModel())
        manager.emit('pull-complete', manager.getModel())
      })

      manager.resetReady()
      await manager.waitUntilReady()

      expect(downloadBinarySpy).toHaveBeenCalledTimes(1)
      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(pullSpy).toHaveBeenCalledTimes(1)
      await expect(access(join(runtimeDir, 'ollama.exe'))).resolves.toBeUndefined()
      await expect(access(join(dataDir, 'serve-ready.txt'))).resolves.toBeUndefined()
      await expect(access(join(dataDir, 'model-ready.txt'))).resolves.toBeUndefined()
      expect(execSyncMock).not.toHaveBeenCalled()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
