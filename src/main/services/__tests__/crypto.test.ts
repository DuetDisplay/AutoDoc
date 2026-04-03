import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fsp from 'fs/promises'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as electron from 'electron'

let mockPaths = {
  appData: '',
  userData: '',
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'appData') return mockPaths.appData
      if (name === 'userData') return mockPaths.userData
      throw new Error(`unexpected app.getPath(${name})`)
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const raw = b.toString()
      if (!raw.startsWith('enc:')) throw new Error('decrypt failed')
      return raw.replace('enc:', '')
    }),
  },
}))

async function freshImport() {
  vi.resetModules()
  return await import('../crypto')
}

describe('crypto module', () => {
  let tmpDir: string
  let appDataDir: string
  let userDataDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-crypto-test-'))
    appDataDir = path.join(tmpDir, 'appData')
    userDataDir = path.join(tmpDir, 'userData')
    mockPaths = { appData: appDataDir, userData: userDataDir }
    await fsp.mkdir(appDataDir, { recursive: true })
    await fsp.mkdir(userDataDir, { recursive: true })
    vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(electron.safeStorage.encryptString).mockImplementation((s: string) => Buffer.from(`enc:${s}`))
    vi.mocked(electron.safeStorage.decryptString).mockImplementation((b: Buffer) => {
      const raw = b.toString()
      if (!raw.startsWith('enc:')) throw new Error('decrypt failed')
      return raw.replace('enc:', '')
    })
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  describe('getKey', () => {
    it('generates a 32-byte key', async () => {
      const { getKey } = await freshImport()
      const key = getKey()
      expect(key).toBeInstanceOf(Buffer)
      expect(key.length).toBe(32)
    })

    it('returns the same key on subsequent calls', async () => {
      const { getKey } = await freshImport()
      const key1 = getKey()
      const key2 = getKey()
      expect(key1.equals(key2)).toBe(true)
    })

    it('persists key across module reloads in the stable appData store', async () => {
      const mod1 = await freshImport()
      const key1 = mod1.getKey()

      const stableStorePath = path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json')
      expect(fs.existsSync(stableStorePath)).toBe(true)

      const mod2 = await freshImport()
      const key2 = mod2.getKey()

      expect(key1.equals(key2)).toBe(true)
    })

    it('recovers a key from the legacy userData store and re-persists it to the stable store', async () => {
      const legacyStorePath = path.join(userDataDir, 'autodoc-encryption.json')
      const expectedKey = crypto.randomBytes(32)
      await fsp.writeFile(legacyStorePath, JSON.stringify({
        encryption_key: `enc:${expectedKey.toString('base64')}`,
        encryption_key_version: 1,
      }))

      const { getKey } = await freshImport()
      const recovered = getKey()

      expect(recovered.equals(expectedKey)).toBe(true)
      const stableStoreRaw = await fsp.readFile(path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json'), 'utf-8')
      expect(stableStoreRaw).toContain('enc:')
    })

    it('falls back to plaintext when safeStorage unavailable', async () => {
      vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(false)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { getKey } = await freshImport()
      const key = getKey()

      expect(key.length).toBe(32)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('initializeEncryption', () => {
    it('blocks startup if encrypted recordings exist but no key can be recovered', async () => {
      const { encryptFileInPlace } = await freshImport()

      const plainPath = path.join(tmpDir, 'source.webm')
      await fsp.writeFile(plainPath, crypto.randomBytes(128))
      await encryptFileInPlace(plainPath)

      const recordingsDir = path.join(tmpDir, 'recordings')
      const meetingDir = path.join(recordingsDir, 'meeting-1')
      await fsp.mkdir(meetingDir, { recursive: true })
      await fsp.rename(plainPath, path.join(meetingDir, 'mic.webm'))

      await fsp.rm(path.join(appDataDir, 'AutoDoc'), { recursive: true, force: true })
      const { initializeEncryption, EncryptionKeyUnavailableError } = await freshImport()
      await expect(initializeEncryption(recordingsDir)).rejects.toBeInstanceOf(EncryptionKeyUnavailableError)
    })
  })

  describe('JSON encrypt/decrypt', () => {
    it('round-trips JSON data', async () => {
      const { encryptJSON, decryptJSON } = await freshImport()
      const data = { hello: 'world', nested: { arr: [1, 2, 3] } }
      const filePath = path.join(tmpDir, 'test.json')

      await encryptJSON(data, filePath)
      const result = await decryptJSON(filePath)

      expect(result).toEqual(data)
    })

    it('throws on tampered ciphertext', async () => {
      const { encryptJSON, decryptJSON } = await freshImport()
      const filePath = path.join(tmpDir, 'tampered.json')
      await encryptJSON({ secret: true }, filePath)

      const buf = await fsp.readFile(filePath)
      buf[buf.length - 1] ^= 0xff
      await fsp.writeFile(filePath, buf)

      await expect(decryptJSON(filePath)).rejects.toThrow()
    })
  })

  describe('chunked media encrypt/decrypt', () => {
    it('round-trips a multi-block file', async () => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'large.webm')
      const original = crypto.randomBytes(65536 * 2 + 1234)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)
      const tmpPath = await decryptFileToTemp(filePath)
      const decrypted = await fsp.readFile(tmpPath)

      expect(decrypted.equals(original)).toBe(true)
      await fsp.unlink(tmpPath).catch(() => {})
    })

    it('detects tampered encrypted media', async () => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'tampered.webm')
      await fsp.writeFile(filePath, crypto.randomBytes(1000))

      await encryptFileInPlace(filePath)

      const buf = await fsp.readFile(filePath)
      buf[buf.length - 1] ^= 0xff
      await fsp.writeFile(filePath, buf)

      await expect(decryptFileToTemp(filePath)).rejects.toThrow()
    })
  })

  describe('migrateRecordings', () => {
    it('encrypts current media and metadata files', async () => {
      const { migrateRecordings, isEncrypted } = await freshImport()

      const meetingDir = path.join(tmpDir, 'meeting-abc')
      await fsp.mkdir(meetingDir, { recursive: true })

      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), crypto.randomBytes(500))
      await fsp.writeFile(path.join(meetingDir, 'system.webm'), crypto.randomBytes(500))
      await fsp.writeFile(path.join(meetingDir, 'metadata.json'), JSON.stringify({ sourceName: 'test', startedAt: 1, stoppedAt: 2, durationSeconds: 1 }))
      await fsp.writeFile(path.join(meetingDir, 'speakers.json'), JSON.stringify({ Speaker: { label: 'Speaker' } }))

      await migrateRecordings(tmpDir)

      expect(await isEncrypted(path.join(meetingDir, 'mic.webm'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'system.webm'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'metadata.json'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'speakers.json'))).toBe(true)
    })

    it('skips files that are already encrypted', async () => {
      const { encryptJSON, encryptFileInPlace, migrateRecordings, isEncrypted } = await freshImport()

      const meetingDir = path.join(tmpDir, 'meeting-def')
      await fsp.mkdir(meetingDir, { recursive: true })

      const audioPath = path.join(meetingDir, 'mic.webm')
      await fsp.writeFile(audioPath, crypto.randomBytes(500))
      await encryptFileInPlace(audioPath)

      const jsonPath = path.join(meetingDir, 'transcript.json')
      await encryptJSON({ text: 'hello' }, jsonPath)

      const audioBefore = await fsp.readFile(audioPath)
      const jsonBefore = await fsp.readFile(jsonPath)

      await migrateRecordings(tmpDir)

      expect(await isEncrypted(audioPath)).toBe(true)
      expect(await isEncrypted(jsonPath)).toBe(true)
      expect(audioBefore.equals(await fsp.readFile(audioPath))).toBe(true)
      expect(jsonBefore.equals(await fsp.readFile(jsonPath))).toBe(true)
    })
  })

  describe('cleanupTempFiles', () => {
    it('removes autodoc temp files from tmpdir', async () => {
      const { cleanupTempFiles } = await freshImport()

      const tmpFile = path.join(os.tmpdir(), `autodoc-${crypto.randomBytes(8).toString('hex')}.tmp`)
      await fsp.writeFile(tmpFile, 'test')

      await cleanupTempFiles()

      await expect(fsp.access(tmpFile)).rejects.toThrow()
    })
  })
})
