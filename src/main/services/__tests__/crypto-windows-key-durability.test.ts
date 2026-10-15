import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const mocks = vi.hoisted(() => ({
  userData: '',
  protect: vi.fn(),
  unprotect: vi.fn(),
  decryptString: vi.fn(),
  failCommit: false,
  failSync: false,
  encryptionAvailable: true
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => mocks.userData },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`legacy:${value}`),
    decryptString: mocks.decryptString
  }
}))
vi.mock('../windows-key-protection', () => ({
  protectWindowsRecordingKey: mocks.protect,
  unprotectWindowsRecordingKey: mocks.unprotect
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (mocks.failCommit) throw new Error('Commit failed')
      return actual.renameSync(from, to)
    },
    fsyncSync: (fd: number) => {
      if (mocks.failSync) throw new Error('Sync failed')
      return actual.fsyncSync(fd)
    }
  }
})

const storePath = () => join(mocks.userData, 'autodoc-encryption.json')
const readStore = () => JSON.parse(fs.readFileSync(storePath(), 'utf8'))
const fresh = async () => {
  vi.resetModules()
  return import('../crypto')
}

describe('Windows recording key durability', () => {
  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.userData = await fsp.mkdtemp(join(tmpdir(), 'autodoc-dpapi-test-'))
    mocks.encryptionAvailable = true
    mocks.failCommit = false
    mocks.failSync = false
    mocks.protect
      .mockReset()
      .mockImplementation((key: Buffer) => Buffer.concat([Buffer.from('test-protected-key:'), key]))
    mocks.unprotect.mockReset().mockImplementation((value: Buffer) => {
      if (!value.subarray(0, 19).equals(Buffer.from('test-protected-key:'))) {
        throw new Error('Invalid test DPAPI value')
      }
      return value.subarray(19)
    })
    mocks.decryptString.mockReset().mockImplementation((value: Buffer) => {
      if (!value.toString().startsWith('legacy:')) throw new Error('Legacy decryption failed')
      return value.toString().slice(7)
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(mocks.userData, { recursive: true, force: true })
  })

  it('persists the same key with DPAPI and recovers it after Local State is lost', async () => {
    const first = await fresh()
    const key = first.getKey()
    const store = readStore()
    expect(typeof store.encryption_key_dpapi).toBe('string')
    expect(typeof store.encryption_key).toBe('string')
    mocks.decryptString.mockImplementation(() => {
      throw new Error('Local State lost')
    })
    const next = await fresh()
    expect(next.getKey().equals(key)).toBe(true)
    expect(mocks.decryptString).not.toHaveBeenCalled()
  })

  it('backs up a legacy safeStorage key without changing the recording key', async () => {
    const key = randomBytes(32)
    fs.writeFileSync(
      storePath(),
      JSON.stringify({
        encryption_key: `legacy:${key.toString('base64')}`,
        encryption_key_version: 1,
        preserved: 'metadata'
      })
    )
    const crypto = await fresh()
    expect(crypto.getKey().equals(key)).toBe(true)
    expect(typeof readStore().encryption_key_dpapi).toBe('string')
    expect(readStore().preserved).toBe('metadata')
  })

  it.each(['malformed backup', Buffer.from('invalid DPAPI blob').toString('base64')])(
    'falls back to legacy and preserves an invalid backup while repairing it (%s)',
    async (backup) => {
      const key = randomBytes(32)
      fs.writeFileSync(
        storePath(),
        JSON.stringify({
          encryption_key: `legacy:${key.toString('base64')}`,
          encryption_key_dpapi: backup
        })
      )
      const crypto = await fresh()
      expect(crypto.getKey().equals(key)).toBe(true)
      expect(readStore().encryption_key_dpapi_previous).toBe(backup)
      expect(readStore().encryption_key_dpapi).not.toBe(backup)
    }
  )

  it.each(['protect', 'sync', 'commit'] as const)(
    'does not return or cache a legacy key when durable backup %s fails',
    async (phase) => {
      const key = randomBytes(32)
      const original = JSON.stringify({ encryption_key: `legacy:${key.toString('base64')}` })
      fs.writeFileSync(storePath(), original)
      mocks.failCommit = phase === 'commit'
      mocks.failSync = phase === 'sync'
      if (phase === 'protect')
        mocks.protect.mockImplementation(() => {
          throw new Error('Protection failed')
        })
      const crypto = await fresh()
      expect(() => crypto.getKey()).toThrow()
      expect(fs.readFileSync(storePath(), 'utf8') === original).toBe(true)
      mocks.failCommit = false
      mocks.failSync = false
      mocks.protect.mockImplementation((value: Buffer) =>
        Buffer.concat([Buffer.from('test-protected-key:'), value])
      )
      expect(crypto.getKey().equals(key)).toBe(true)
      expect(typeof readStore().encryption_key_dpapi).toBe('string')
    }
  )

  it('can recover the durable backup without safeStorage availability', async () => {
    const first = await fresh()
    const key = first.getKey()
    mocks.encryptionAvailable = false
    const next = await fresh()
    expect(next.getKey().equals(key)).toBe(true)
  })

  it('preserves an inaccessible store and rejects instead of generating a replacement key', async () => {
    const original = JSON.stringify({
      encryption_key: 'inaccessible',
      encryption_key_dpapi: 'broken'
    })
    fs.writeFileSync(storePath(), original)
    const crypto = await fresh()
    expect(() => crypto.getKey()).toThrow(crypto.EncryptionKeyUnavailableError)
    expect(fs.readFileSync(storePath(), 'utf8') === original).toBe(true)
    expect(mocks.protect).not.toHaveBeenCalled()
  })

  it('fails closed if a new key cannot be backed up durably', async () => {
    mocks.protect.mockImplementation(() => {
      throw new Error('Helper unavailable')
    })
    const crypto = await fresh()
    expect(() => crypto.getKey()).toThrow('Helper unavailable')
    expect(fs.existsSync(storePath())).toBe(false)
  })

  it('does not create a plaintext Windows key when safeStorage is unavailable', async () => {
    mocks.encryptionAvailable = false
    const crypto = await fresh()
    expect(() => crypto.getKey()).toThrow()
    expect(fs.existsSync(storePath())).toBe(false)
  })
  it.each(['getKey', 'initializeEncryption'] as const)(
    'retains existing non-Windows empty-store recovery in %s',
    async (method) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      fs.writeFileSync(storePath(), '{}')
      const crypto = await fresh()
      if (method === 'initializeEncryption') {
        const recordings = join(mocks.userData, 'recordings')
        await fsp.mkdir(recordings)
        await crypto.initializeEncryption(recordings)
      }
      expect(crypto.getKey().length).toBe(32)
      expect(mocks.protect).not.toHaveBeenCalled()
    }
  )
})
