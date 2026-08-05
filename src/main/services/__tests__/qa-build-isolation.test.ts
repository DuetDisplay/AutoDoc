import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.doUnmock('child_process')
  vi.resetModules()
  setPlatform(originalPlatform)
})

describe.skipIf(!__AUTODOC_QA_BUILD__)('QA build runtime isolation', () => {
  it('uses a separate managed Ollama endpoint and only kills the QA port', async () => {
    setPlatform('win32')
    vi.resetModules()
    const execSyncMock = vi.fn(() => '')
    const spawnMock = vi.fn(() => ({ on: vi.fn() }))

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'appData' ? 'C:\\AppData' : 'C:\\AppData\\AutoDoc QA'
        ),
        isPackaged: false
      }
    }))
    vi.doMock('child_process', () => ({
      execFile: vi.fn(),
      execSync: execSyncMock,
      spawn: spawnMock
    }))

    const { OllamaManager } = await import('../ollama-manager')
    const manager = new OllamaManager()

    expect(manager.getBaseUrl()).toBe('http://127.0.0.1:11436')
    manager.stop()

    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(':11436'),
      expect.objectContaining({ timeout: 5000 })
    )
    expect(execSyncMock.mock.calls.flat().join(' ')).not.toContain(':11435')
  })

  it('does not reuse the installed production model store in source-run QA builds', async () => {
    vi.resetModules()
    const qaUserData = path.join(os.tmpdir(), 'AutoDoc QA')

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) =>
          name === 'appData' ? path.join(os.tmpdir(), 'app-data') : qaUserData
        ),
        isPackaged: false
      }
    }))
    vi.doMock('child_process', () => ({
      execFile: vi.fn(),
      execSync: vi.fn(),
      spawn: vi.fn()
    }))

    const { OllamaManager } = await import('../ollama-manager')
    const manager = new OllamaManager() as unknown as { getOllamaDataDir(): string }

    expect(manager.getOllamaDataDir()).toBe(path.join(qaUserData, 'ollama-data'))
  })

  it('cleans only QA decrypted-media files', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(), isPackaged: true },
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => true),
        encryptString: vi.fn(),
        decryptString: vi.fn()
      }
    }))

    const { cleanupTempFiles, isCurrentBuildDecryptedTempFileName } = await import('../crypto')
    const productionFile = path.join(
      os.tmpdir(),
      `autodoc-${crypto.randomBytes(8).toString('hex')}.tmp`
    )
    const qaFile = path.join(os.tmpdir(), `autodoc-qa-${crypto.randomBytes(8).toString('hex')}.tmp`)
    await Promise.all([fsp.writeFile(productionFile, 'prod'), fsp.writeFile(qaFile, 'qa')])

    try {
      expect(isCurrentBuildDecryptedTempFileName(path.basename(productionFile))).toBe(false)
      expect(isCurrentBuildDecryptedTempFileName(path.basename(qaFile))).toBe(true)
      await cleanupTempFiles()

      await expect(fsp.access(productionFile)).resolves.toBeUndefined()
      await expect(fsp.access(qaFile)).rejects.toThrow()
    } finally {
      await fsp.unlink(productionFile).catch(() => {})
      await fsp.unlink(qaFile).catch(() => {})
    }
  })
})
