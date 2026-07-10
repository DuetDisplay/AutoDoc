import * as crypto from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Readable } from 'stream'
import { execFileSync } from 'child_process'
import { app, safeStorage } from 'electron'
import { renameWithRetry } from './file-operation-retry'

const STORE_KEY = 'encryption_key'
const STORE_VERSION_KEY = 'encryption_key_version'
const STORE_FILENAME = 'autodoc-encryption.json'
const CANONICAL_APP_DIR = 'AutoDoc'

const MAGIC = Buffer.from('ADOC', 'ascii')
const BLOCK_SIZE = 65536 // 64KB plaintext per block
const CHUNKED_VERSION = 0x01
const MEDIA_DECRYPT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const MEDIA_DECRYPT_CACHE_MAX_ENTRIES = 6
const LEGACY_MAC_SAFE_STORAGE_SERVICES = [
  'AutoDoc Safe Storage',
  'autodoc Safe Storage',
  'Autodoc Safe Storage',
  'Electron Safe Storage'
] as const

interface StoredKeyFile {
  [STORE_KEY]?: string
  [STORE_VERSION_KEY]?: number
}

export class EncryptionKeyUnavailableError extends Error {
  constructor(message = 'Encryption key unavailable for existing encrypted recordings') {
    super(message)
    this.name = 'EncryptionKeyUnavailableError'
  }
}

// ─── Key Management ───

let cachedKey: Buffer | null = null
let cachedKeyError: Error | null = null

function usesIsolatedStore(): boolean {
  return (
    !app.isPackaged ||
    Boolean(process.env.AUTODOC_TEST_USER_DATA_DIR) ||
    process.env.AUTODOC_E2E === '1' ||
    process.env.AUTODOC_TEST_REAL_SETUP === '1'
  )
}

function getPrimaryStorePath(): string {
  if (usesIsolatedStore()) {
    return path.join(app.getPath('userData'), STORE_FILENAME)
  }
  return path.join(app.getPath('appData'), CANONICAL_APP_DIR, STORE_FILENAME)
}

function getLegacyStorePaths(): string[] {
  if (usesIsolatedStore()) {
    return [getPrimaryStorePath()]
  }

  const paths = new Set<string>([
    path.join(app.getPath('userData'), STORE_FILENAME),
    path.join(app.getPath('appData'), 'autodoc', STORE_FILENAME),
    path.join(app.getPath('appData'), 'Autodoc', STORE_FILENAME),
    path.join(app.getPath('appData'), 'Electron', STORE_FILENAME),
    getPrimaryStorePath()
  ])

  return [...paths]
}

function readStoreFile(filePath: string): StoredKeyFile | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredKeyFile
  } catch {
    return null
  }
}

function writeStoreFile(filePath: string, data: StoredKeyFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(data))
  fs.renameSync(tempPath, filePath)
}

function persistKey(key: Buffer): void {
  const b64 = key.toString('base64')
  const storedValue = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(b64).toString('latin1')
    : b64

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('safeStorage not available — storing encryption key as plaintext')
  }

  writeStoreFile(getPrimaryStorePath(), {
    [STORE_KEY]: storedValue,
    [STORE_VERSION_KEY]: 1
  })
}

function generateAndPersistKey(): Buffer {
  const key = crypto.randomBytes(32)
  persistKey(key)
  cachedKey = key
  cachedKeyError = null
  return key
}

function decodeStoredKey(storedValue: string): Buffer | null {
  try {
    const b64 = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(storedValue, 'latin1'))
      : storedValue
    const key = Buffer.from(b64, 'base64')
    return key.length === 32 ? key : null
  } catch (err) {
    console.warn('Failed to decrypt stored encryption key — trying legacy recovery:', err)
    return tryRecoverFromLegacyKeychain(storedValue)
  }
}

function loadKeyFromKnownStores(): Buffer | null {
  for (const storePath of getLegacyStorePaths()) {
    const store = readStoreFile(storePath)
    const storedValue = store?.[STORE_KEY]
    if (typeof storedValue !== 'string' || storedValue.length === 0) {
      continue
    }

    const key = decodeStoredKey(storedValue)
    if (!key) {
      continue
    }

    cachedKey = key
    cachedKeyError = null
    if (storePath !== getPrimaryStorePath()) {
      persistKey(key)
    }
    return key
  }

  return null
}

export function getKey(): Buffer {
  if (cachedKey) return cachedKey
  if (cachedKeyError) throw cachedKeyError

  const recovered = loadKeyFromKnownStores()
  if (recovered) return recovered

  return generateAndPersistKey()
}

/**
 * Tries known legacy macOS Chromium safeStorage service names.
 */
function tryRecoverFromLegacyKeychain(storedEncrypted: string): Buffer | null {
  if (process.platform !== 'darwin') return null
  for (const serviceName of LEGACY_MAC_SAFE_STORAGE_SERVICES) {
    try {
      const recovered = tryRecoverFromMacSafeStorageService(storedEncrypted, serviceName)
      if (recovered) {
        console.log(
          `Successfully recovered encryption key from legacy keychain service: ${serviceName}`
        )
        return recovered
      }
    } catch {
      // Try the next service name.
    }
  }

  return null
}

function tryRecoverFromMacSafeStorageService(
  storedEncrypted: string,
  serviceName: string
): Buffer | null {
  const legacyPassword = execFileSync(
    'security',
    ['find-generic-password', '-s', serviceName, '-w'],
    { timeout: 5000 }
  )
    .toString()
    .trim()

  const buf = Buffer.from(storedEncrypted, 'latin1')
  if (buf.length < 19 || buf.toString('ascii', 0, 3) !== 'v10') {
    return null
  }

  const iv = buf.subarray(3, 19)
  const ciphertext = buf.subarray(19)
  const derivedKey = crypto.pbkdf2Sync(legacyPassword, 'saltysalt', 1003, 16, 'sha1')
  const decipher = crypto.createDecipheriv('aes-128-cbc', derivedKey, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const key = Buffer.from(decrypted.toString('utf-8'), 'base64')
  return key.length === 32 ? key : null
}

async function recordingsContainEncryptedFiles(recordingsBaseDir: string): Promise<boolean> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(recordingsBaseDir, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const meetingDir = path.join(recordingsBaseDir, entry.name)
    const files = await fsp.readdir(meetingDir).catch(() => [] as string[])
    for (const filename of files) {
      const filePath = path.join(meetingDir, filename)
      if (await isEncrypted(filePath)) {
        return true
      }
    }
  }

  return false
}

export async function initializeEncryption(recordingsBaseDir: string): Promise<void> {
  if (cachedKey) return
  if (cachedKeyError) throw cachedKeyError

  const recovered = loadKeyFromKnownStores()
  if (recovered) {
    cachedKey = recovered
    return
  }

  if (await recordingsContainEncryptedFiles(recordingsBaseDir)) {
    cachedKeyError = new EncryptionKeyUnavailableError(
      'Encrypted recordings exist but the AutoDoc encryption key could not be recovered. Restore the prior autodoc-encryption.json store before retrying transcription.'
    )
    throw cachedKeyError
  }

  generateAndPersistKey()
}

// ─── JSON Encrypt/Decrypt ───

export async function encryptJSON(data: unknown, filePath: string): Promise<void> {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const aad = Buffer.from(path.basename(filePath), 'utf-8')
  const plaintext = Buffer.from(JSON.stringify(data), 'utf-8')

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: [4-byte ADOC][12-byte IV][16-byte tag][ciphertext]
  const output = Buffer.concat([MAGIC, iv, tag, encrypted])
  const tempPath = filePath + '.enc'
  await fsp.writeFile(tempPath, output)
  await renameWithRetry(tempPath, filePath)
}

export async function decryptJSON<T>(filePath: string): Promise<T> {
  const key = getKey()
  const buf = await fsp.readFile(filePath)
  const aad = Buffer.from(path.basename(filePath), 'utf-8')

  const iv = buf.subarray(4, 16)
  const tag = buf.subarray(16, 32)
  const ciphertext = buf.subarray(32)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return JSON.parse(decrypted.toString('utf-8')) as T
}

// ─── Chunked Media Encrypt/Decrypt ───

function xorNonce(baseNonce: Buffer, blockIndex: number): Buffer {
  const nonce = Buffer.from(baseNonce)
  // XOR block index as 4-byte big-endian into the last 4 bytes
  const idxBuf = Buffer.alloc(4)
  idxBuf.writeUInt32BE(blockIndex, 0)
  for (let i = 0; i < 4; i++) {
    nonce[8 + i] ^= idxBuf[i]
  }
  return nonce
}

function blockAAD(blockIndex: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(blockIndex, 0)
  return buf
}

export async function encryptFileInPlace(plainPath: string): Promise<void> {
  const key = getKey()
  const baseNonce = crypto.randomBytes(12)
  const plainData = await fsp.readFile(plainPath)

  const encPath = plainPath + '.enc'
  const fd = await fsp.open(encPath, 'w')

  try {
    // Write header: ADOC + version + base nonce
    const header = Buffer.concat([MAGIC, Buffer.from([CHUNKED_VERSION]), baseNonce])
    await fd.write(header)

    let offset = 0
    let blockIndex = 0
    while (offset < plainData.length) {
      const end = Math.min(offset + BLOCK_SIZE, plainData.length)
      const block = plainData.subarray(offset, end)

      const iv = xorNonce(baseNonce, blockIndex)
      const aad = blockAAD(blockIndex)

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      const encrypted = Buffer.concat([cipher.update(block), cipher.final()])
      const tag = cipher.getAuthTag()

      // Write: [16-byte tag][ciphertext]
      await fd.write(Buffer.concat([tag, encrypted]))

      offset = end
      blockIndex++
    }

    await fd.close()
  } catch (err) {
    await fd.close()
    await fsp.unlink(encPath).catch(() => {})
    throw err
  }

  // Atomic rename over original
  await renameWithRetry(encPath, plainPath)
}

export async function decryptFileToTemp(encPath: string): Promise<string> {
  const key = getKey()
  const ext = path.extname(encPath) || '.tmp'
  const tmpFilePath = path.join(
    os.tmpdir(),
    `autodoc-${crypto.randomBytes(8).toString('hex')}${ext}`
  )

  const srcFd = await fsp.open(encPath, 'r')
  const dstFd = await fsp.open(tmpFilePath, 'w')

  try {
    const stat = await srcFd.stat()
    const fileSize = stat.size

    // Read header: 4 (ADOC) + 1 (version) + 12 (nonce) = 17 bytes
    const headerBuf = Buffer.alloc(17)
    await srcFd.read(headerBuf, 0, 17, 0)
    const baseNonce = headerBuf.subarray(5, 17)

    let fileOffset = 17
    let blockIndex = 0

    while (fileOffset < fileSize) {
      // Read tag (16 bytes)
      const tagBuf = Buffer.alloc(16)
      await srcFd.read(tagBuf, 0, 16, fileOffset)
      fileOffset += 16

      // Read ciphertext: up to BLOCK_SIZE bytes, but could be less for last block
      const remaining = fileSize - fileOffset
      const ciphertextLen = Math.min(BLOCK_SIZE, remaining)
      const ciphertext = Buffer.alloc(ciphertextLen)
      await srcFd.read(ciphertext, 0, ciphertextLen, fileOffset)
      fileOffset += ciphertextLen

      const iv = xorNonce(baseNonce, blockIndex)
      const aad = blockAAD(blockIndex)

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(aad)
      decipher.setAuthTag(tagBuf)
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

      await dstFd.write(decrypted)
      blockIndex++
    }

    // Success path: close both handles, return path
    await srcFd.close()
    await dstFd.close()
    return tmpFilePath
  } catch (err) {
    // Error path: close handles, unlink temp, re-throw
    await srcFd.close()
    await dstFd.close()
    await fsp.unlink(tmpFilePath).catch(() => {})
    throw err
  }
}

/** Cached decrypted paths for custom-protocol media (one decrypt per recording file, not per HTTP range). */
const mediaDecryptCache = new Map<
  string,
  { tempPath: string; mtimeMs: number; size: number; lastAccessedMs: number }
>()
const mediaDecryptInflight = new Map<string, Promise<string>>()

export async function clearMediaDecryptCache(): Promise<void> {
  for (const { tempPath } of mediaDecryptCache.values()) {
    await fsp.unlink(tempPath).catch(() => {})
  }
  mediaDecryptCache.clear()
  mediaDecryptInflight.clear()
}

async function pruneMediaDecryptCache(): Promise<void> {
  let totalBytes = 0
  for (const entry of mediaDecryptCache.values()) {
    totalBytes += entry.size
  }

  if (
    mediaDecryptCache.size <= MEDIA_DECRYPT_CACHE_MAX_ENTRIES &&
    totalBytes <= MEDIA_DECRYPT_CACHE_MAX_BYTES
  ) {
    return
  }

  const entries = [...mediaDecryptCache.entries()].sort(
    ([, a], [, b]) => a.lastAccessedMs - b.lastAccessedMs
  )
  for (const [encPath, entry] of entries) {
    if (
      mediaDecryptCache.size <= MEDIA_DECRYPT_CACHE_MAX_ENTRIES &&
      totalBytes <= MEDIA_DECRYPT_CACHE_MAX_BYTES
    ) {
      break
    }

    try {
      await fsp.unlink(entry.tempPath)
      mediaDecryptCache.delete(encPath)
      totalBytes -= entry.size
    } catch {
      // Keep the entry tracked so a later prune or shutdown can retry cleanup.
    }
  }
}

/**
 * Decrypt encrypted media to a temp file once per source path (until the file changes on disk).
 * Deduplicates concurrent decrypts. Used by the loopback recording media server so range requests do not each
 * decrypt hundreds of MB.
 */
export async function getDecryptedTempPathForMedia(encPath: string): Promise<string> {
  const st = await fsp.stat(encPath)
  const cached = mediaDecryptCache.get(encPath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    try {
      await fsp.access(cached.tempPath)
      cached.lastAccessedMs = Date.now()
      return cached.tempPath
    } catch {
      mediaDecryptCache.delete(encPath)
    }
  }
  if (cached) {
    await fsp.unlink(cached.tempPath).catch(() => {})
    mediaDecryptCache.delete(encPath)
  }

  let inflight = mediaDecryptInflight.get(encPath)
  if (!inflight) {
    inflight = (async () => {
      const tmp = await decryptFileToTemp(encPath)
      const stFresh = await fsp.stat(encPath)
      mediaDecryptCache.set(encPath, {
        tempPath: tmp,
        mtimeMs: stFresh.mtimeMs,
        size: stFresh.size,
        lastAccessedMs: Date.now()
      })
      await pruneMediaDecryptCache()
      return tmp
    })().finally(() => {
      mediaDecryptInflight.delete(encPath)
    })
    mediaDecryptInflight.set(encPath, inflight)
  }
  return inflight
}

export function createDecryptStream(encPath: string): Readable {
  const key = getKey()

  async function* decryptBlocks(): AsyncGenerator<Buffer> {
    const fd = await fsp.open(encPath, 'r')
    try {
      const stat = await fd.stat()
      const fileSize = stat.size

      // Read header
      const headerBuf = Buffer.alloc(17)
      await fd.read(headerBuf, 0, 17, 0)
      const baseNonce = headerBuf.subarray(5, 17)

      let fileOffset = 17
      let blockIndex = 0

      while (fileOffset < fileSize) {
        const tagBuf = Buffer.alloc(16)
        await fd.read(tagBuf, 0, 16, fileOffset)
        fileOffset += 16

        const remaining = fileSize - fileOffset
        const ciphertextLen = Math.min(BLOCK_SIZE, remaining)
        const ciphertext = Buffer.alloc(ciphertextLen)
        await fd.read(ciphertext, 0, ciphertextLen, fileOffset)
        fileOffset += ciphertextLen

        const iv = xorNonce(baseNonce, blockIndex)
        const aad = blockAAD(blockIndex)

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(aad)
        decipher.setAuthTag(tagBuf)
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

        yield decrypted
        blockIndex++
      }
    } finally {
      await fd.close()
    }
  }

  return Readable.from(decryptBlocks())
}

// ─── Detection & Migration ───

export async function isEncrypted(filePath: string): Promise<boolean> {
  try {
    const fd = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await fd.read(buf, 0, 4, 0)
      await fd.close()
      if (bytesRead < 4) return false
      return buf.equals(MAGIC)
    } catch {
      await fd.close()
      return false
    }
  } catch {
    // File doesn't exist or can't be opened
    return false
  }
}

export async function migrateRecordings(recordingsBaseDir: string): Promise<void> {
  const targetFiles = [
    'audio.webm',
    'mic.webm',
    'system.webm',
    'screen.webm',
    'transcript.json',
    'segments.json',
    'speakers.json',
    'metadata.json'
  ]

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(recordingsBaseDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meetingDir = path.join(recordingsBaseDir, entry.name)

    // Clean up stale .enc temp files first
    const meetingFiles = await fsp.readdir(meetingDir).catch(() => [] as string[])
    for (const f of meetingFiles) {
      if (f.endsWith('.enc')) {
        console.log(`Cleaning up stale temp file: ${path.join(meetingDir, f)}`)
        await fsp.unlink(path.join(meetingDir, f)).catch(() => {})
      }
    }

    for (const filename of targetFiles) {
      const filePath = path.join(meetingDir, filename)

      try {
        await fsp.access(filePath)
      } catch {
        continue // file doesn't exist
      }

      if (await isEncrypted(filePath)) {
        console.log(`Already encrypted, skipping: ${filePath}`)
        continue
      }

      console.log(`Encrypting: ${filePath}`)

      if (filename.endsWith('.json')) {
        // Read plain JSON, encrypt it
        const raw = await fsp.readFile(filePath, 'utf-8')
        const data = JSON.parse(raw)
        await encryptJSON(data, filePath)
      } else {
        await encryptFileInPlace(filePath)
      }
    }
  }
}

export async function cleanupTempFiles(): Promise<void> {
  await clearMediaDecryptCache()
  const tmpdir = os.tmpdir()
  const entries = await fsp.readdir(tmpdir)

  for (const entry of entries) {
    if (/^autodoc-[0-9a-f]{16}\./.test(entry)) {
      await fsp.unlink(path.join(tmpdir, entry)).catch(() => {})
    }
  }
}
