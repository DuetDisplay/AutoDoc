import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fsp from 'fs/promises'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as electron from 'electron'

let mockPaths = {
  appData: '',
  userData: ''
}
let mockIsPackaged = true

vi.mock('../windows-key-protection', () => ({
  protectWindowsRecordingKey: (key: Buffer) => Buffer.concat([Buffer.from('test-dpapi:'), key]),
  unprotectWindowsRecordingKey: (value: Buffer) => value.subarray(11)
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: vi.fn((name: string) => {
      if (name === 'appData') return mockPaths.appData
      if (name === 'userData') return mockPaths.userData
      throw new Error(`unexpected app.getPath(${name})`)
    })
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const raw = b.toString()
      if (!raw.startsWith('enc:')) throw new Error('decrypt failed')
      return raw.replace('enc:', '')
    })
  }
}))

const mockLogAutodocFailure = vi.hoisted(() => vi.fn())
vi.mock('../autodoc-log', () => ({ logAutodocFailure: mockLogAutodocFailure }))

const BLOCK = 65536

// Reproduces the pre-streaming whole-buffer algorithm to prove on-disk compatibility.
function legacyEncrypt(
  key: Buffer,
  plain: Buffer,
  baseNonce: Buffer = crypto.randomBytes(12)
): Buffer {
  const parts: Buffer[] = [Buffer.from('ADOC', 'ascii'), Buffer.from([1]), baseNonce]
  let blockIndex = 0
  for (let offset = 0; offset < plain.length; offset += BLOCK) {
    const iv = Buffer.from(baseNonce)
    const idx = Buffer.alloc(4)
    idx.writeUInt32BE(blockIndex, 0)
    for (let i = 0; i < 4; i++) iv[8 + i] ^= idx[i]
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(idx)
    const enc = Buffer.concat([
      cipher.update(plain.subarray(offset, offset + BLOCK)),
      cipher.final()
    ])
    parts.push(cipher.getAuthTag(), enc)
    blockIndex++
  }
  return Buffer.concat(parts)
}

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
    mockIsPackaged = true
    await fsp.mkdir(appDataDir, { recursive: true })
    await fsp.mkdir(userDataDir, { recursive: true })
    vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(electron.safeStorage.encryptString).mockImplementation((s: string) =>
      Buffer.from(`enc:${s}`)
    )
    vi.mocked(electron.safeStorage.decryptString).mockImplementation((b: Buffer) => {
      const raw = b.toString()
      if (!raw.startsWith('enc:')) throw new Error('decrypt failed')
      return raw.replace('enc:', '')
    })
  })

  afterEach(async () => {
    delete process.env.AUTODOC_TEST_USER_DATA_DIR
    delete process.env.AUTODOC_E2E
    delete process.env.AUTODOC_TEST_REAL_SETUP
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
      await fsp.writeFile(
        legacyStorePath,
        JSON.stringify({
          encryption_key: `enc:${expectedKey.toString('base64')}`,
          encryption_key_version: 1
        })
      )

      const { getKey } = await freshImport()
      const recovered = getKey()

      expect(recovered.equals(expectedKey)).toBe(true)
      const stableStoreRaw = await fsp.readFile(
        path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json'),
        'utf-8'
      )
      expect(stableStoreRaw).toContain('enc:')
    })

    it('only permits the existing plaintext fallback outside Windows', async () => {
      vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(false)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { getKey } = await freshImport()
      if (process.platform === 'win32') {
        expect(() => getKey()).toThrow('Windows secure key storage is unavailable')
        expect(warnSpy).not.toHaveBeenCalled()
      } else {
        expect(getKey().length).toBe(32)
        expect(warnSpy).toHaveBeenCalled()
      }
      warnSpy.mockRestore()
    })

    it('keeps isolated test runs inside the temp userData directory', async () => {
      process.env.AUTODOC_TEST_USER_DATA_DIR = userDataDir

      const { getKey } = await freshImport()
      getKey()

      expect(fs.existsSync(path.join(userDataDir, 'autodoc-encryption.json'))).toBe(true)
      expect(fs.existsSync(path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json'))).toBe(false)
    })

    it('uses an isolated userData store in dev without touching the production appData store', async () => {
      mockIsPackaged = false
      await fsp.mkdir(path.join(appDataDir, 'AutoDoc'), { recursive: true })
      await fsp.writeFile(
        path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json'),
        JSON.stringify({
          encryption_key: 'enc:not-the-dev-key',
          encryption_key_version: 1
        })
      )

      const { getKey } = await freshImport()
      const devKey = getKey()

      const devStoreRaw = await fsp.readFile(
        path.join(userDataDir, 'autodoc-encryption.json'),
        'utf-8'
      )
      const prodStoreRaw = await fsp.readFile(
        path.join(appDataDir, 'AutoDoc', 'autodoc-encryption.json'),
        'utf-8'
      )

      expect(devStoreRaw).toContain('enc:')
      expect(prodStoreRaw).toContain('not-the-dev-key')
      expect(
        Buffer.from(JSON.parse(devStoreRaw).encryption_key.replace('enc:', ''), 'base64').equals(
          devKey
        )
      ).toBe(true)
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
      await expect(initializeEncryption(recordingsDir)).rejects.toBeInstanceOf(
        EncryptionKeyUnavailableError
      )
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

    it.each([
      ['empty', 0],
      ['1 byte', 1],
      ['exactly one block', BLOCK],
      ['three blocks plus remainder', BLOCK * 3 + 1234]
    ])('round-trips %s', async (_name, size) => {
      const { encryptFileInPlace, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'sized.webm')
      const original = crypto.randomBytes(size)
      await fsp.writeFile(filePath, original)

      await encryptFileInPlace(filePath)
      const encSize = (await fsp.stat(filePath)).size
      expect(encSize).toBe(17 + Math.ceil(size / BLOCK) * 16 + size)
      const tmpPath = await decryptFileToTemp(filePath)
      expect((await fsp.readFile(tmpPath)).equals(original)).toBe(true)
      await fsp.unlink(tmpPath).catch(() => {})
    })

    it('decrypts files written by the previous whole-buffer algorithm', async () => {
      const { getKey, decryptFileToTemp } = await freshImport()
      const filePath = path.join(tmpDir, 'legacy.webm')
      const original = crypto.randomBytes(BLOCK * 2 + 77)
      await fsp.writeFile(filePath, legacyEncrypt(getKey(), original))

      const tmpPath = await decryptFileToTemp(filePath)
      expect((await fsp.readFile(tmpPath)).equals(original)).toBe(true)
      await fsp.unlink(tmpPath).catch(() => {})
    })

    it('produces the same bytes as the previous algorithm for a fixed nonce', async () => {
      const { getKey, encryptFileInPlace } = await freshImport()
      const filePath = path.join(tmpDir, 'compat.webm')
      const original = crypto.randomBytes(BLOCK + 5)
      await fsp.writeFile(filePath, original)
      await encryptFileInPlace(filePath)
      const enc = await fsp.readFile(filePath)
      // Re-encrypt with the legacy algorithm using the nonce from the new file's header.
      const baseNonce = enc.subarray(5, 17)
      const legacy = legacyEncrypt(getKey(), original, Buffer.from(baseNonce))
      expect(enc.equals(legacy)).toBe(true)
    })

    // Writes ~2 GiB of ciphertext, so it only runs with AUTODOC_LARGE_FILE_TESTS=1.
    it.skipIf(!process.env.AUTODOC_LARGE_FILE_TESTS)(
      'encrypts a sparse file over 2 GiB past the 2 GiB readFile limit',
      async () => {
        const { encryptFileInPlace, isEncrypted } = await freshImport()
        const filePath = path.join(tmpDir, 'huge.webm')
        const fd = fs.openSync(filePath, 'w')
        fs.ftruncateSync(fd, 2 ** 31 + 1024)
        fs.closeSync(fd)

        await expect(encryptFileInPlace(filePath)).resolves.toBeUndefined()

        expect(await isEncrypted(filePath)).toBe(true)
        const expectedBlocks = Math.ceil((2 ** 31 + 1024) / BLOCK)
        expect((await fsp.stat(filePath)).size).toBe(17 + expectedBlocks * 16 + 2 ** 31 + 1024)
      },
      120_000
    )

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
    it('keeps encrypting later meetings when one file fails, then throws once', async () => {
      const { migrateRecordings, isEncrypted } = await freshImport()
      mockLogAutodocFailure.mockClear()

      const badDir = path.join(tmpDir, 'meeting-a')
      const goodDir = path.join(tmpDir, 'meeting-b')
      await fsp.mkdir(badDir, { recursive: true })
      await fsp.mkdir(goodDir, { recursive: true })
      // Invalid JSON makes the JSON branch fail; the media file in the same dir should still be done.
      await fsp.writeFile(path.join(badDir, 'metadata.json'), '{not json')
      await fsp.writeFile(path.join(badDir, 'mic.webm'), crypto.randomBytes(300))
      await fsp.writeFile(path.join(goodDir, 'mic.webm'), crypto.randomBytes(300))
      await fsp.writeFile(path.join(goodDir, 'speakers.json'), JSON.stringify({ a: 1 }))

      await expect(migrateRecordings(tmpDir)).rejects.toThrow(/one or more meeting files/)

      expect(await isEncrypted(path.join(badDir, 'mic.webm'))).toBe(true)
      expect(await isEncrypted(path.join(goodDir, 'mic.webm'))).toBe(true)
      expect(await isEncrypted(path.join(goodDir, 'speakers.json'))).toBe(true)
      expect(mockLogAutodocFailure).toHaveBeenCalledTimes(1)
      const logged = mockLogAutodocFailure.mock.calls[0][0]
      expect(logged.area).toBe('recording')
      expect(logged.meetingId).toBe('meeting-a')
      expect(logged.context).toEqual({ filename: 'metadata.json' })
    })

    it('continues past a media file that fails to encrypt', async () => {
      const { migrateRecordings, isEncrypted } = await freshImport()
      const badDir = path.join(tmpDir, 'meeting-a')
      const goodDir = path.join(tmpDir, 'meeting-b')
      await fsp.mkdir(badDir, { recursive: true })
      await fsp.mkdir(goodDir, { recursive: true })
      // A directory named like a media file passes access() but cannot be read as a file.
      await fsp.mkdir(path.join(badDir, 'screen.webm'))
      await fsp.writeFile(path.join(goodDir, 'screen.webm'), crypto.randomBytes(300))

      await expect(migrateRecordings(tmpDir)).rejects.toThrow()
      expect(await isEncrypted(path.join(goodDir, 'screen.webm'))).toBe(true)
    })

    it('encrypts current media and metadata files', async () => {
      const { migrateRecordings, isEncrypted } = await freshImport()

      const meetingDir = path.join(tmpDir, 'meeting-abc')
      await fsp.mkdir(meetingDir, { recursive: true })

      await fsp.writeFile(path.join(meetingDir, 'mic.webm'), crypto.randomBytes(500))
      await fsp.writeFile(path.join(meetingDir, 'system.webm'), crypto.randomBytes(500))
      await fsp.writeFile(
        path.join(meetingDir, 'metadata.json'),
        JSON.stringify({ sourceName: 'test', startedAt: 1, stoppedAt: 2, durationSeconds: 1 })
      )
      await fsp.writeFile(
        path.join(meetingDir, 'speakers.json'),
        JSON.stringify({ Speaker: { label: 'Speaker' } })
      )

      await migrateRecordings(tmpDir)

      expect(await isEncrypted(path.join(meetingDir, 'mic.webm'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'system.webm'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'metadata.json'))).toBe(true)
      expect(await isEncrypted(path.join(meetingDir, 'speakers.json'))).toBe(true)
    })

    it('skips files that are already encrypted', async () => {
      const { encryptJSON, encryptFileInPlace, migrateRecordings, isEncrypted } =
        await freshImport()

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

    it('recognizes only production-flavor decrypted temp filenames', async () => {
      const { isCurrentBuildDecryptedTempFileName } = await freshImport()

      expect(isCurrentBuildDecryptedTempFileName('autodoc-0123456789abcdef.webm')).toBe(true)
      expect(isCurrentBuildDecryptedTempFileName('autodoc-qa-0123456789abcdef.webm')).toBe(false)
      expect(isCurrentBuildDecryptedTempFileName('autodoc-../../recording.webm')).toBe(false)
    })

    it('does not remove QA temp files from a production build cleanup', async () => {
      const { cleanupTempFiles } = await freshImport()

      const productionFile = path.join(
        os.tmpdir(),
        `autodoc-${crypto.randomBytes(8).toString('hex')}.tmp`
      )
      const qaFile = path.join(
        os.tmpdir(),
        `autodoc-qa-${crypto.randomBytes(8).toString('hex')}.tmp`
      )
      await Promise.all([fsp.writeFile(productionFile, 'prod'), fsp.writeFile(qaFile, 'qa')])

      try {
        await cleanupTempFiles()

        await expect(fsp.access(productionFile)).rejects.toThrow()
        await expect(fsp.access(qaFile)).resolves.toBeUndefined()
      } finally {
        await fsp.unlink(productionFile).catch(() => {})
        await fsp.unlink(qaFile).catch(() => {})
      }
    })
  })
})
