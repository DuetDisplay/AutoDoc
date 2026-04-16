import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

async function loadOllamaManager(platform: 'darwin' | 'win32', rootDir: string) {
  setPlatform(platform)
  vi.resetModules()

  const execSyncMock = vi.fn()
  const spawnMock = vi.fn()
  const execFileMock = vi.fn()

  vi.doMock('electron', () => ({
    app: {
      getPath: vi.fn(() => rootDir),
    },
  }))

  vi.doMock('child_process', () => ({
    spawn: spawnMock,
    execFile: execFileMock,
    execSync: execSyncMock,
  }))

  const mod = await import('../ollama-manager')
  return {
    OllamaManager: mod.OllamaManager,
    execSyncMock,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.resetModules()
  setPlatform(originalPlatform)
})

describe('Ollama onboarding dependency installation', () => {
  it('installs a macOS runtime binary and waits for startup plus model pull before resolving', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-mac-'))

    try {
      const { OllamaManager, execSyncMock } = await loadOllamaManager('darwin', rootDir)
      execSyncMock.mockImplementation(() => {
        throw new Error('not installed')
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

      await expect(access(join(rootDir, 'models', 'ollama-runtime', 'ollama'))).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data', 'serve-ready.txt'))).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data', 'model-ready.txt'))).resolves.toBeUndefined()
      await expect(readFile(join(rootDir, 'ollama-data', 'model-ready.txt'), 'utf-8')).resolves.toContain(
        manager.getModel(),
      )
      expect(statuses).toEqual(['download-start', 'download-complete', 'pull-start', 'pull-complete'])
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('installs a Windows runtime binary before startup continues', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-ollama-win-'))

    try {
      const { OllamaManager } = await loadOllamaManager('win32', rootDir)
      const manager = new OllamaManager()

      vi.spyOn(manager as never, 'downloadBinary').mockImplementation(async () => {
        const runtimeDir = join(rootDir, 'models', 'ollama-runtime')
        await mkdir(runtimeDir, { recursive: true })
        await writeFile(join(runtimeDir, 'ollama.exe'), 'binary')
      })

      await manager.ensureReady()

      await expect(access(join(rootDir, 'models', 'ollama-runtime', 'ollama.exe'))).resolves.toBeUndefined()
      await expect(access(join(rootDir, 'ollama-data'))).resolves.toBeUndefined()
      await expect(manager.isReady()).resolves.toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
