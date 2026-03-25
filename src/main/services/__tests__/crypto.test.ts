import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace('enc:', '')),
  },
}))

// Shared backing store for electron-store mock — exposed so tests can clear it
const storeData = new Map<string, unknown>()

vi.mock('electron-store', () => {
  return {
    default: class {
      get(key: string) { return storeData.get(key) }
      set(key: string, val: unknown) { storeData.set(key, val) }
      delete(key: string) { storeData.delete(key) }
      clear() { storeData.clear() }
    },
  }
})

// Reset modules + clear store so each test gets a fresh key singleton
async function freshImport() {
  storeData.clear()
  vi.resetModules()
  return await import('../crypto')
}

describe('crypto module', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autodoc-crypto-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  // ─── Key Management ───

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

    it('persists key across module reloads', async () => {
      // First import — generates and stores a key
      storeData.clear()
      vi.resetModules()
      const mod1 = await import('../crypto')
      const key1 = mod1.getKey()

      // Second import — should load from store (don't clear storeData this time)
      vi.resetModules()
      const mod2 = await import('../crypto')
      const key2 = mod2.getKey()

      expect(key1.equals(key2)).toBe(true)
    })

    it('falls back to plaintext when safeStorage unavailable', async () => {
      const electron = await import('electron')
      vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(false)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { getKey } = await freshImport()
      const key = getKey()

      expect(key.length).toBe(32)
      expect(warnSpy).toHaveBeenCalled()

      vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(true)
      warnSpy.mockRestore()
    })
  })

  // ─── JSON Encrypt/Decrypt ───

  describe('JSON encrypt/decrypt', () => {
    it('round-trips JSON data', async () => {
      const { encryptJSON, decryptJSON } = await freshImport()
      const data = { hello: 'world', nested: { arr: [1, 2, 3] } }
      const filePath = path.join(tmpDir, 'test.json')

      await encryptJSON(data, filePath)
      const result = await decryptJSON(filePath)

      expect(result).toEqual(data)
    })

    it('writes ADOC magic header', async () => {
      const { encryptJSON } = await freshImport()
      const filePath = path.join(tmpDir, 'magic.json')
      await encryptJSON({ foo: 'bar' }, filePath)

      const buf = await fsp.readFile(filePath)
      expect(buf.subarray(0, 4).toString('ascii')).toBe('ADOC')
    })

    it('generates different IVs per write', async () => {
      const { encryptJSON } = await freshImport()
      const filePath1 = path.join(tmpDir, 'iv1.json')
      const filePath2 = path.join(tmpDir, 'iv2.json')

      await encryptJSON({ a: 1 }, filePath1)
      await encryptJSON({ a: 1 }, filePath2)

      const buf1 = await fsp.readFile(filePath1)
      const buf2 = await fsp.readFile(filePath2)

      // IV is bytes 4..16
      const iv1 = buf1.subarray(4, 16)
      const iv2 = buf2.subarray(4, 16)
      expect(iv1.equals(iv2)).toBe(false)
    })

    it('throws on tampered ciphertext', async () => {
      const { encryptJSON, decryptJSON } = await freshImport()
      const filePath = path.join(tmpDir, 'tampered.json')
      await encryptJSON({ secret: true }, filePath)

      // Tamper with ciphertext (last byte)
      const buf = await fsp.readFile(filePath)
      buf[buf.length - 1] ^= 0xff
      await fsp.writeFile(filePath, buf)

      await expect(decryptJSON(filePath)).rejects.toThrow()
    })
  })

  // ─── Chunked Media Encrypt/Decrypt ───

  describe('chunked media encrypt/decrypt', () => {
    it('round-trips a small file', async () => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'small.webm')
      const original = crypto.randomBytes(1000)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)

      // File should now be encrypted (starts with ADOC)
      const encBuf = await fsp.readFile(filePath)
      expect(encBuf.subarray(0, 4).toString('ascii')).toBe('ADOC')

      const tmpPath = await decryptFileToTemp(filePath)
      const decrypted = await fsp.readFile(tmpPath)
      expect(decrypted.equals(original)).toBe(true)

      await fsp.unlink(tmpPath).catch(() => {})
    })

    it('round-trips a multi-block file (>64KB)', async () => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'large.webm')
      // 3 full blocks + partial
      const original = crypto.randomBytes(65536 * 3 + 12345)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)
      const tmpPath = await decryptFileToTemp(filePath)
      const decrypted = await fsp.readFile(tmpPath)
      expect(decrypted.equals(original)).toBe(true)

      await fsp.unlink(tmpPath).catch(() => {})
    })

    it('createDecryptStream works', async () => {
      const { encryptFileInPlace, createDecryptStream } = await freshImport()
      const filePath = path.join(tmpDir, 'stream.webm')
      const original = crypto.randomBytes(65536 * 2 + 500)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)

      const stream = createDecryptStream(filePath)
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const decrypted = Buffer.concat(chunks)
      expect(decrypted.equals(original)).toBe(true)
    })

    it('detects tampered block', async () => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'tampered.webm')
      const original = crypto.randomBytes(1000)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)

      // Tamper with ciphertext in the first block
      const buf = await fsp.readFile(filePath)
      buf[buf.length - 1] ^= 0xff
      await fsp.writeFile(filePath, buf)

      await expect(decryptFileToTemp(filePath)).rejects.toThrow()
    })
  })

  // ─── isEncrypted ───

  describe('isEncrypted', () => {
    it('returns true for encrypted JSON', async () => {
      const { encryptJSON, isEncrypted } = await freshImport()
      const filePath = path.join(tmpDir, 'enc.json')
      await encryptJSON({ test: true }, filePath)

      expect(await isEncrypted(filePath)).toBe(true)
    })

    it('returns true for encrypted media', async () => {
      const { encryptFileInPlace, isEncrypted } = await freshImport()
      const filePath = path.join(tmpDir, 'enc.webm')
      await fsp.writeFile(filePath, crypto.randomBytes(100))
      await encryptFileInPlace(filePath)

      expect(await isEncrypted(filePath)).toBe(true)
    })

    it('returns false for plain JSON', async () => {
      const { isEncrypted } = await freshImport()
      const filePath = path.join(tmpDir, 'plain.json')
      await fsp.writeFile(filePath, JSON.stringify({ hello: 'world' }))

      expect(await isEncrypted(filePath)).toBe(false)
    })

    it('returns false for plain WebM (0x1A header)', async () => {
      const { isEncrypted } = await freshImport()
      const filePath = path.join(tmpDir, 'plain.webm')
      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
      await fsp.writeFile(filePath, webmHeader)

      expect(await isEncrypted(filePath)).toBe(false)
    })

    it('returns false for nonexistent file', async () => {
      const { isEncrypted } = await freshImport()
      expect(await isEncrypted(path.join(tmpDir, 'nope.json'))).toBe(false)
    })
  })

  // ─── Migration ───

  describe('migrateRecordings', () => {
    it('encrypts unencrypted files', async () => {
      const { migrateRecordings, isEncrypted } = await freshImport()

      const meetingDir = path.join(tmpDir, 'meeting-abc')
      await fsp.mkdir(meetingDir, { recursive: true })

      await fsp.writeFile(path.join(meetingDir, 'audio.webm'), crypto.randomBytes(500))
      await fsp.writeFile(path.join(meetingDir, 'transcript.json'), JSON.stringify({ text: 'hello' }))

      await migrateRecordings(tmpDir)

      expect(await isEncrypted(path.join(meetingDir, 'audio.webm'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'transcript.json'))).toBe(true)
    })

    it('skips already-encrypted files', async () => {
      const { encryptJSON, encryptFileInPlace, migrateRecordings, isEncrypted } = await freshImport()

      const meetingDir = path.join(tmpDir, 'meeting-def')
      await fsp.mkdir(meetingDir, { recursive: true })

      // Pre-encrypt
      const audioPath = path.join(meetingDir, 'audio.webm')
      await fsp.writeFile(audioPath, crypto.randomBytes(500))
      await encryptFileInPlace(audioPath)

      const jsonPath = path.join(meetingDir, 'transcript.json')
      await encryptJSON({ text: 'hello' }, jsonPath)

      // Get the encrypted content before migration
      const audioBefore = await fsp.readFile(audioPath)
      const jsonBefore = await fsp.readFile(jsonPath)

      await migrateRecordings(tmpDir)

      // Files should still be encrypted and unchanged
      expect(await isEncrypted(audioPath)).toBe(true)
      expect(await isEncrypted(jsonPath)).toBe(true)

      const audioAfter = await fsp.readFile(audioPath)
      const jsonAfter = await fsp.readFile(jsonPath)
      expect(audioBefore.equals(audioAfter)).toBe(true)
      expect(jsonBefore.equals(jsonAfter)).toBe(true)
    })
  })

  // ─── cleanupTempFiles ───

  describe('cleanupTempFiles', () => {
    it('removes autodoc-*.tmp files from tmpdir', async () => {
      const { cleanupTempFiles } = await freshImport()

      const tmpFile1 = path.join(os.tmpdir(), `autodoc-test1-${Date.now()}.tmp`)
      const tmpFile2 = path.join(os.tmpdir(), `autodoc-test2-${Date.now()}.tmp`)
      await fsp.writeFile(tmpFile1, 'test')
      await fsp.writeFile(tmpFile2, 'test')

      await cleanupTempFiles()

      await expect(fsp.access(tmpFile1)).rejects.toThrow()
      await expect(fsp.access(tmpFile2)).rejects.toThrow()
    })
  })
})
