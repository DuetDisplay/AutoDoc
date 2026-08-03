import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  renameMock,
  readFileMock,
  writeFileMock,
  openMock,
  unlinkMock,
  writeFileSyncMock,
  readFileSyncMock,
  renameSyncMock
} = vi.hoisted(() => ({
  renameMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  openMock: vi.fn(),
  unlinkMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  renameSyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'appData' ? '/mock/appData' : '/mock/userData')),
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
  unlink: unlinkMock,
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
    unlinkMock.mockResolvedValue(undefined)
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

  it('AUTODOC-3E waits beyond the short retry window for a Windows media lock', async () => {
    vi.useFakeTimers()
    const { encryptFileInPlace } = await freshImport()
    const locked = Object.assign(new Error('EPERM: destination is locked'), { code: 'EPERM' })
    renameMock
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockRejectedValueOnce(locked)
      .mockResolvedValue(undefined)

    const encryption = expect(
      encryptFileInPlace('/mock/recordings/meeting-1/system.webm')
    ).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await encryption

    expect(renameMock).toHaveBeenCalledTimes(6)
    expect(renameMock).toHaveBeenLastCalledWith(
      '/mock/recordings/meeting-1/system.webm.enc',
      '/mock/recordings/meeting-1/system.webm'
    )
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('AUTODOC-3E preserves the plaintext and encrypted temp after Windows retries exhaust', async () => {
    vi.useFakeTimers()
    const { encryptFileInPlace } = await freshImport()
    const locked = Object.assign(new Error('EPERM: destination is locked'), { code: 'EPERM' })
    renameMock.mockRejectedValue(locked)

    const encryption = expect(
      encryptFileInPlace('/mock/recordings/meeting-1/system.webm')
    ).rejects.toMatchObject({ code: 'EPERM' })
    await vi.runAllTimersAsync()
    await encryption

    expect(renameMock).toHaveBeenCalledTimes(7)
    expect(openMock).toHaveBeenCalledWith('/mock/recordings/meeting-1/system.webm.enc', 'w')
    expect(unlinkMock).not.toHaveBeenCalled()
  })

  it('AUTODOC-3E leaves non-Windows media rename behavior unchanged', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true
    })
    const { encryptFileInPlace } = await freshImport()
    const locked = Object.assign(new Error('EPERM: destination is locked'), { code: 'EPERM' })
    renameMock.mockRejectedValue(locked)

    await expect(
      encryptFileInPlace('/mock/recordings/meeting-1/system.webm')
    ).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(unlinkMock).not.toHaveBeenCalled()
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
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    })
  })
})
