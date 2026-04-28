import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return userDataPath
      throw new Error(`unexpected app.getPath(${name})`)
    }),
  },
}))

async function freshImport() {
  vi.resetModules()
  return await import('../storage-manager')
}

describe('storage-manager', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-storage-test-'))
    userDataPath = tempDir
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('reports managed downloads separately from recordings and logs', async () => {
    await fsp.mkdir(path.join(tempDir, 'models'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'ollama-data'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'recordings', 'meeting-1'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'logs'), { recursive: true })

    await fsp.writeFile(path.join(tempDir, 'models', 'ggml-large-v3.bin'), Buffer.alloc(10))
    await fsp.writeFile(path.join(tempDir, 'ollama-data', 'blob.bin'), Buffer.alloc(20))
    await fsp.writeFile(path.join(tempDir, 'recordings', 'meeting-1', 'audio.webm'), Buffer.alloc(30))
    await fsp.writeFile(path.join(tempDir, 'logs', 'autodoc.log'), Buffer.alloc(5))
    await fsp.writeFile(path.join(tempDir, 'autodoc-prefs.json'), Buffer.alloc(7))

    const { getAppStorageInfo } = await freshImport()
    const storageInfo = await getAppStorageInfo()

    expect(storageInfo.downloadedComponentsBytes).toBe(30)
    expect(storageInfo.recordingsBytes).toBe(30)
    expect(storageInfo.logsBytes).toBe(5)
    expect(storageInfo.otherLocalDataBytes).toBe(7)
    expect(storageInfo.totalBytes).toBe(72)
  })

  it('removes managed download directories without touching recordings', async () => {
    await fsp.mkdir(path.join(tempDir, 'models'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'ollama-data'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'recordings', 'meeting-1'), { recursive: true })

    await fsp.writeFile(path.join(tempDir, 'models', 'ggml-large-v3.bin'), Buffer.alloc(10))
    await fsp.writeFile(path.join(tempDir, 'ollama-data', 'blob.bin'), Buffer.alloc(20))
    await fsp.writeFile(path.join(tempDir, 'recordings', 'meeting-1', 'audio.webm'), Buffer.alloc(30))

    const { clearDownloadedComponents } = await freshImport()
    await clearDownloadedComponents()

    await expect(fsp.access(path.join(tempDir, 'models'))).rejects.toThrow()
    await expect(fsp.access(path.join(tempDir, 'ollama-data'))).rejects.toThrow()
    await expect(fsp.access(path.join(tempDir, 'recordings', 'meeting-1', 'audio.webm'))).resolves.toBeUndefined()
  })

  it('captures path diagnostics for recordings, managed downloads, and extra paths', async () => {
    await fsp.mkdir(path.join(tempDir, 'models'), { recursive: true })
    await fsp.mkdir(path.join(tempDir, 'recordings', 'meeting-2'), { recursive: true })
    await fsp.writeFile(path.join(tempDir, 'models', 'ggml-large-v3.bin'), Buffer.alloc(10))
    await fsp.writeFile(path.join(tempDir, 'recordings', 'meeting-2', 'audio.webm'), Buffer.alloc(30))

    const { getStorageDiagnostics } = await freshImport()
    const diagnostics = await getStorageDiagnostics({
      meetingDir: path.join(tempDir, 'recordings', 'meeting-2'),
      whisperModelPath: path.join(tempDir, 'models', 'ggml-large-v3.bin'),
      missingPath: path.join(tempDir, 'models', 'missing.bin'),
    })

    expect(diagnostics.recordings).toMatchObject({
      kind: 'directory',
      entryCount: 1,
      entriesSample: ['meeting-2'],
    })
    expect(diagnostics.managedDownloads.models).toMatchObject({
      kind: 'directory',
      entryCount: 1,
      entriesSample: ['ggml-large-v3.bin'],
    })
    expect(diagnostics.managedDownloads.ollamaData).toMatchObject({
      kind: 'missing',
    })
    expect(diagnostics.extraPaths?.meetingDir).toMatchObject({
      kind: 'directory',
      entryCount: 1,
      entriesSample: ['audio.webm'],
    })
    expect(diagnostics.extraPaths?.whisperModelPath).toMatchObject({
      kind: 'file',
      sizeBytes: 10,
    })
    expect(diagnostics.extraPaths?.missingPath).toMatchObject({
      kind: 'missing',
    })
  })
})
