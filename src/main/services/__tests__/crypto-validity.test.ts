import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  renameMock,
  readFileMock,
  writeFileMock,
  openMock,
  writeFileSyncMock,
  readFileSyncMock,
  renameSyncMock
} = vi.hoisted(() => ({
  renameMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  openMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  renameSyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === 'appData' ? '/mock/appData' : '/mock/userData'
    ),
    isPackaged: true
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^enc:/, ''))
  }
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  open: openMock,
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: renameMock
}))

vi.mock('fs', () => ({
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  renameSync: renameSyncMock,
  mkdirSync: vi.fn(),
  Dirent: class {}
}))

async function freshImport() {
  vi.resetModules()
  return await import('../crypto')
}

describe('Crypto file replacement retries', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        encryption_key: 'enc:' + Buffer.alloc(32, 1).toString('base64'),
        encryption_key_version: 1
      })
    )
    readFileMock.mockResolvedValue(Buffer.from('plain-data'))
    writeFileMock.mockResolvedValue(undefined)
    openMock.mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('retries replacing encrypted media files when Windows reports EPERM', async () => {
    const { encryptFileInPlace } = await freshImport()
    renameMock
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: file is locked'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: file is locked'), { code: 'EPERM' }))
      .mockResolvedValue(undefined)

    await expect(
      encryptFileInPlace('/mock/recordings/meeting-1/screen.webm')
    ).resolves.toBeUndefined()
    expect(renameMock).toHaveBeenCalledTimes(3)
  })

  it('retries replacing encrypted JSON metadata when Windows reports EPERM', async () => {
    const { encryptJSON } = await freshImport()
    renameMock
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: file is locked'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: file is locked'), { code: 'EPERM' }))
      .mockResolvedValue(undefined)

    await expect(
      encryptJSON({ isFinalizing: false }, '/mock/recordings/meeting-1/metadata.json')
    ).resolves.toBeUndefined()
    expect(renameMock).toHaveBeenCalledTimes(3)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    })
  })
})
