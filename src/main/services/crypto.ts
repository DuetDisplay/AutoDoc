import * as crypto from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { Readable } from 'stream'
import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({ name: 'autodoc-encryption' })
const STORE_KEY = 'encryption_key'
const STORE_VERSION_KEY = 'encryption_key_version'

const MAGIC = Buffer.from('ADOC', 'ascii')
const BLOCK_SIZE = 65536 // 64KB plaintext per block
const CHUNKED_VERSION = 0x01

// ─── Key Management ───

let cachedKey: Buffer | null = null

export function getKey(): Buffer {
  if (cachedKey) return cachedKey

  // Try loading from store
  const stored = store.get(STORE_KEY) as string | undefined
  if (stored) {
    let b64: string
    if (safeStorage.isEncryptionAvailable()) {
      b64 = safeStorage.decryptString(Buffer.from(stored, 'latin1'))
    } else {
      b64 = stored
    }
    cachedKey = Buffer.from(b64, 'base64')
    return cachedKey
  }

  // Generate new key
  const key = crypto.randomBytes(32)
  const b64 = key.toString('base64')

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(b64)
    store.set(STORE_KEY, encrypted.toString('latin1'))
  } else {
    console.warn('safeStorage not available — storing encryption key as plaintext')
    store.set(STORE_KEY, b64)
  }
  store.set(STORE_VERSION_KEY, 1)

  cachedKey = key
  return cachedKey
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
  await fsp.rename(tempPath, filePath)
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
  await fsp.rename(encPath, plainPath)
}

export async function decryptFileToTemp(encPath: string): Promise<string> {
  const key = getKey()
  const tmpFilePath = path.join(os.tmpdir(), `autodoc-${crypto.randomBytes(8).toString('hex')}.tmp`)

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
  const targetFiles = ['audio.webm', 'screen.webm', 'transcript.json', 'segments.json']

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
  const tmpdir = os.tmpdir()
  const entries = await fsp.readdir(tmpdir)

  for (const entry of entries) {
    if (/^autodoc-.*\.tmp$/.test(entry)) {
      await fsp.unlink(path.join(tmpdir, entry)).catch(() => {})
    }
  }
}
