# Encryption at Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt all local meeting data (audio, video, transcripts, segments) with AES-256-GCM, storing the encryption key in the OS keychain.

**Architecture:** A single crypto module (`src/main/services/crypto.ts`) provides key management, JSON encrypt/decrypt, and chunked media encrypt/decrypt. All file I/O in the main process routes through this module. The renderer is unaware of encryption — it's fully transparent.

**Tech Stack:** Node.js `crypto` (AES-256-GCM), Electron `safeStorage`, `electron-store`, `vitest`

**Spec:** `docs/superpowers/specs/2026-03-25-encryption-at-rest-design.md`

---

### Task 1: Crypto Module — Key Management

**Files:**
- Create: `src/main/services/crypto.ts`
- Create: `src/main/services/__tests__/crypto.test.ts`

- [ ] **Step 1: Write failing tests for key management**

```ts
// src/main/services/__tests__/crypto.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace('enc:', '')),
  },
}))

vi.mock('electron-store', () => {
  const data = new Map<string, unknown>()
  return {
    default: class {
      get(key: string) { return data.get(key) }
      set(key: string, val: unknown) { data.set(key, val) }
      delete(key: string) { data.delete(key) }
      clear() { data.clear() }
    },
  }
})

describe('Key Management', () => {
  beforeEach(async () => {
    vi.resetModules()
    const Store = (await import('electron-store')).default
    new Store().clear()
  })

  it('generates a 32-byte key on first call', async () => {
    const { getKey } = await import('../crypto')
    const key = getKey()
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it('returns the same key on subsequent calls', async () => {
    const { getKey } = await import('../crypto')
    const key1 = getKey()
    const key2 = getKey()
    expect(key1.equals(key2)).toBe(true)
  })

  it('persists the key across module reloads', async () => {
    const mod1 = await import('../crypto')
    const key1 = mod1.getKey()

    // Clear the in-memory cache by resetting modules, but the store retains data
    vi.resetModules()
    const mod2 = await import('../crypto')
    const key2 = mod2.getKey()
    expect(key1.equals(key2)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: FAIL — `crypto` module does not exist

- [ ] **Step 3: Implement key management**

```ts
// src/main/services/crypto.ts
import { safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import Store from 'electron-store'

const store = new Store({ name: 'autodoc-encryption' })
const KEY_STORE_KEY = 'encryption_key'
const KEY_VERSION_KEY = 'encryption_key_version'

let cachedKey: Buffer | null = null

export function getKey(): Buffer {
  if (cachedKey) return cachedKey

  const stored = store.get(KEY_STORE_KEY) as string | undefined
  if (stored) {
    // Load existing key
    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'latin1'))
      cachedKey = Buffer.from(decrypted, 'base64')
    } else {
      cachedKey = Buffer.from(stored, 'base64')
    }
  } else {
    // Generate new key
    cachedKey = randomBytes(32)
    const b64 = cachedKey.toString('base64')
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(b64)
      store.set(KEY_STORE_KEY, encrypted.toString('latin1'))
    } else {
      console.warn('safeStorage unavailable — encryption key stored in plaintext')
      store.set(KEY_STORE_KEY, b64)
    }
    store.set(KEY_VERSION_KEY, 1)
  }

  return cachedKey
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/crypto.ts src/main/services/__tests__/crypto.test.ts
git commit -m "feat(crypto): add key management with safeStorage"
```

---

### Task 2: Crypto Module — JSON Encrypt/Decrypt

**Files:**
- Modify: `src/main/services/crypto.ts`
- Modify: `src/main/services/__tests__/crypto.test.ts`

- [ ] **Step 1: Write failing tests for JSON encrypt/decrypt**

Add to `crypto.test.ts`:

```ts
import { join } from 'path'
import { tmpdir } from 'os'
import { readFile, unlink, mkdir } from 'fs/promises'

describe('JSON Encrypt/Decrypt', () => {
  const testDir = join(tmpdir(), 'autodoc-crypto-test')
  const testFile = join(testDir, 'test.json')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await unlink(testFile).catch(() => {})
  })

  it('round-trips JSON data', async () => {
    const { encryptJSON, decryptJSON } = await import('../crypto')
    const data = { hello: 'world', nested: { arr: [1, 2, 3] } }
    await encryptJSON(data, testFile)
    const result = await decryptJSON(testFile)
    expect(result).toEqual(data)
  })

  it('writes ADOC magic bytes as header', async () => {
    const { encryptJSON } = await import('../crypto')
    await encryptJSON({ test: true }, testFile)
    const raw = await readFile(testFile)
    expect(raw.subarray(0, 4).toString()).toBe('ADOC')
  })

  it('produces different ciphertext for same data (random IV)', async () => {
    const { encryptJSON } = await import('../crypto')
    await encryptJSON({ same: 'data' }, testFile)
    const raw1 = await readFile(testFile)
    await encryptJSON({ same: 'data' }, testFile)
    const raw2 = await readFile(testFile)
    // IVs at bytes 4-15 should differ
    expect(raw1.subarray(4, 16).equals(raw2.subarray(4, 16))).toBe(false)
  })

  it('throws on tampered ciphertext', async () => {
    const { encryptJSON, decryptJSON } = await import('../crypto')
    await encryptJSON({ data: 'value' }, testFile)
    const raw = await readFile(testFile)
    // Flip a byte in the ciphertext (after 32-byte header)
    raw[32] ^= 0xff
    const { writeFile } = await import('fs/promises')
    await writeFile(testFile, raw)
    await expect(decryptJSON(testFile)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: FAIL — `encryptJSON` and `decryptJSON` not exported

- [ ] **Step 3: Implement JSON encrypt/decrypt**

Add to `crypto.ts`:

```ts
import { createCipheriv, createDecipheriv } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'

const MAGIC = Buffer.from('ADOC') // 4 bytes

export async function encryptJSON(data: unknown, filePath: string): Promise<void> {
  const key = getKey()
  const iv = randomBytes(12)
  const aad = Buffer.from(basename(filePath))
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)

  const plaintext = Buffer.from(JSON.stringify(data))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag() // 16 bytes

  // File format: [4 ADOC][12 IV][16 tag][ciphertext]
  const output = Buffer.concat([MAGIC, iv, tag, ciphertext])
  await writeFile(filePath, output)
}

export async function decryptJSON<T = unknown>(filePath: string): Promise<T> {
  const key = getKey()
  const raw = await readFile(filePath)

  // Parse header: [4 ADOC][12 IV][16 tag][ciphertext]
  const magic = raw.subarray(0, 4)
  if (!magic.equals(MAGIC)) {
    throw new Error(`Not an encrypted file: ${filePath}`)
  }

  const iv = raw.subarray(4, 16)
  const tag = raw.subarray(16, 32)
  const ciphertext = raw.subarray(32)
  const aad = Buffer.from(basename(filePath))

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/crypto.ts src/main/services/__tests__/crypto.test.ts
git commit -m "feat(crypto): add JSON encrypt/decrypt with AES-256-GCM"
```

---

### Task 3: Crypto Module — Chunked Media Encrypt/Decrypt

**Files:**
- Modify: `src/main/services/crypto.ts`
- Modify: `src/main/services/__tests__/crypto.test.ts`

- [ ] **Step 1: Write failing tests for chunked encrypt/decrypt**

Add to `crypto.test.ts`:

```ts
import { writeFile as fsWriteFile } from 'fs/promises'
import { randomBytes as nodeRandomBytes } from 'crypto'

describe('Chunked Media Encrypt/Decrypt', () => {
  const testDir = join(tmpdir(), 'autodoc-crypto-test')
  const mediaFile = join(testDir, 'test.webm')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await unlink(mediaFile).catch(() => {})
    await unlink(mediaFile + '.enc').catch(() => {})
  })

  it('round-trips a small file via encryptFileInPlace + decryptFileToTemp', async () => {
    const { encryptFileInPlace, decryptFileToTemp } = await import('../crypto')
    const original = nodeRandomBytes(1000)
    await fsWriteFile(mediaFile, original)

    await encryptFileInPlace(mediaFile)

    // File should now be encrypted (starts with ADOC)
    const encrypted = await readFile(mediaFile)
    expect(encrypted.subarray(0, 4).toString()).toBe('ADOC')
    expect(encrypted.subarray(4, 5)[0]).toBe(0x01) // version

    const tempPath = await decryptFileToTemp(mediaFile)
    const decrypted = await readFile(tempPath)
    expect(decrypted.equals(original)).toBe(true)
    await unlink(tempPath)
  })

  it('round-trips a multi-block file (>64KB)', async () => {
    const { encryptFileInPlace, decryptFileToTemp } = await import('../crypto')
    // 3.5 blocks worth of data
    const original = nodeRandomBytes(64 * 1024 * 3 + 32768)
    await fsWriteFile(mediaFile, original)

    await encryptFileInPlace(mediaFile)
    const tempPath = await decryptFileToTemp(mediaFile)
    const decrypted = await readFile(tempPath)
    expect(decrypted.equals(original)).toBe(true)
    await unlink(tempPath)
  })

  it('creates a readable decrypt stream', async () => {
    const { encryptFileInPlace, createDecryptStream } = await import('../crypto')
    const original = nodeRandomBytes(100000)
    await fsWriteFile(mediaFile, original)
    await encryptFileInPlace(mediaFile)

    const stream = createDecryptStream(mediaFile)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
    }
    const decrypted = Buffer.concat(chunks)
    expect(decrypted.equals(original)).toBe(true)
  })

  it('detects tampered block', async () => {
    const { encryptFileInPlace, decryptFileToTemp } = await import('../crypto')
    const original = nodeRandomBytes(1000)
    await fsWriteFile(mediaFile, original)
    await encryptFileInPlace(mediaFile)

    // Tamper with encrypted data (flip byte in first block ciphertext)
    const raw = await readFile(mediaFile)
    const firstCiphertextByte = 4 + 1 + 12 + 16 // magic + version + nonce + tag
    raw[firstCiphertextByte] ^= 0xff
    await fsWriteFile(mediaFile, raw)

    await expect(decryptFileToTemp(mediaFile)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: FAIL — `encryptFileInPlace`, `decryptFileToTemp`, `createDecryptStream` not exported

- [ ] **Step 3: Implement chunked media encrypt/decrypt**

Add to `crypto.ts`:

```ts
import { createReadStream } from 'fs'
import { open, rename, unlink as fsUnlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

const CHUNKED_VERSION = 0x01
const BLOCK_SIZE = 65536 // 64KB plaintext per block
const HEADER_SIZE = 4 + 1 + 12 // ADOC + version + base nonce = 17 bytes
const TAG_SIZE = 16

function deriveBlockIV(baseNonce: Buffer, blockIndex: number): Buffer {
  const iv = Buffer.from(baseNonce)
  // XOR block index into last 4 bytes as big-endian
  const offset = iv.length - 4
  iv[offset] ^= (blockIndex >>> 24) & 0xff
  iv[offset + 1] ^= (blockIndex >>> 16) & 0xff
  iv[offset + 2] ^= (blockIndex >>> 8) & 0xff
  iv[offset + 3] ^= blockIndex & 0xff
  return iv
}

function blockAAD(blockIndex: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(blockIndex)
  return buf
}

export async function encryptFileInPlace(plainPath: string): Promise<void> {
  const key = getKey()
  const baseNonce = randomBytes(12)
  const tempPath = plainPath + '.enc'

  const inputHandle = await open(plainPath, 'r')
  const outputHandle = await open(tempPath, 'w')

  try {
    // Write header: ADOC + version + base nonce
    const header = Buffer.concat([MAGIC, Buffer.from([CHUNKED_VERSION]), baseNonce])
    await outputHandle.write(header)

    const readBuf = Buffer.alloc(BLOCK_SIZE)
    let blockIndex = 0

    while (true) {
      const { bytesRead } = await inputHandle.read(readBuf, 0, BLOCK_SIZE)
      if (bytesRead === 0) break

      const plaintext = readBuf.subarray(0, bytesRead)
      const iv = deriveBlockIV(baseNonce, blockIndex)
      const aad = blockAAD(blockIndex)

      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()

      // Write: [16-byte tag][ciphertext]
      await outputHandle.write(tag)
      await outputHandle.write(ciphertext)

      blockIndex++
    }
  } finally {
    await inputHandle.close()
    await outputHandle.close()
  }

  // Atomic rename
  await rename(tempPath, plainPath)
}

export async function decryptFileToTemp(encPath: string): Promise<string> {
  const key = getKey()
  const tempPath = join(tmpdir(), `autodoc-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)

  const inputHandle = await open(encPath, 'r')
  const outputHandle = await open(tempPath, 'w')

  try {
    // Read header
    const headerBuf = Buffer.alloc(HEADER_SIZE)
    await inputHandle.read(headerBuf, 0, HEADER_SIZE)

    const magic = headerBuf.subarray(0, 4)
    if (!magic.equals(MAGIC)) throw new Error('Not an encrypted file')
    const version = headerBuf[4]
    if (version !== CHUNKED_VERSION) throw new Error(`Unsupported version: ${version}`)
    const baseNonce = headerBuf.subarray(5, 17)

    let blockIndex = 0
    const tagBuf = Buffer.alloc(TAG_SIZE)

    while (true) {
      // Read tag
      const { bytesRead: tagRead } = await inputHandle.read(tagBuf, 0, TAG_SIZE)
      if (tagRead === 0) break // End of file
      if (tagRead < TAG_SIZE) throw new Error('Truncated block tag')

      // Read ciphertext (up to BLOCK_SIZE bytes — encrypted block is same size as plaintext for GCM)
      const ciphertextBuf = Buffer.alloc(BLOCK_SIZE)
      const { bytesRead: ctRead } = await inputHandle.read(ciphertextBuf, 0, BLOCK_SIZE)
      if (ctRead === 0) throw new Error('Truncated block ciphertext')
      const ciphertext = ciphertextBuf.subarray(0, ctRead)

      const iv = deriveBlockIV(baseNonce, blockIndex)
      const aad = blockAAD(blockIndex)

      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(aad)
      decipher.setAuthTag(tagBuf)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

      await outputHandle.write(plaintext)
      blockIndex++
    }
  } catch (err) {
    await inputHandle.close()
    await outputHandle.close()
    await fsUnlink(tempPath).catch(() => {})
    throw err
  }

  await inputHandle.close()
  await outputHandle.close()

  return tempPath
}

export function createDecryptStream(encPath: string): Readable {
  return Readable.from(decryptBlocks(encPath, getKey()))
}

async function* decryptBlocks(encPath: string, key: Buffer): AsyncGenerator<Buffer> {
  const handle = await open(encPath, 'r')

  try {
    const headerBuf = Buffer.alloc(HEADER_SIZE)
    await handle.read(headerBuf, 0, HEADER_SIZE)

    const magic = headerBuf.subarray(0, 4)
    if (!magic.equals(MAGIC)) throw new Error('Not an encrypted file')
    if (headerBuf[4] !== CHUNKED_VERSION) throw new Error('Unsupported version')
    const baseNonce = headerBuf.subarray(5, 17)

    let blockIndex = 0
    const tagBuf = Buffer.alloc(TAG_SIZE)

    while (true) {
      const { bytesRead: tagRead } = await handle.read(tagBuf, 0, TAG_SIZE)
      if (tagRead === 0) break
      if (tagRead < TAG_SIZE) throw new Error('Truncated block tag')

      const ciphertextBuf = Buffer.alloc(BLOCK_SIZE)
      const { bytesRead: ctRead } = await handle.read(ciphertextBuf, 0, BLOCK_SIZE)
      if (ctRead === 0) throw new Error('Truncated block ciphertext')
      const ciphertext = ciphertextBuf.subarray(0, ctRead)

      const iv = deriveBlockIV(baseNonce, blockIndex)
      const aad = blockAAD(blockIndex)

      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(aad)
      decipher.setAuthTag(tagBuf)

      yield Buffer.concat([decipher.update(ciphertext), decipher.final()])
      blockIndex++
    }
  } finally {
    await handle.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/crypto.ts src/main/services/__tests__/crypto.test.ts
git commit -m "feat(crypto): add chunked media encrypt/decrypt"
```

---

### Task 4: Crypto Module — isEncrypted Detection + Migration Helper

**Files:**
- Modify: `src/main/services/crypto.ts`
- Modify: `src/main/services/__tests__/crypto.test.ts`

- [ ] **Step 1: Write failing tests for detection and migration**

Add to `crypto.test.ts`:

```ts
describe('isEncrypted', () => {
  const testDir = join(tmpdir(), 'autodoc-crypto-test')
  const testFile = join(testDir, 'detect.bin')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await unlink(testFile).catch(() => {})
  })

  it('returns true for encrypted JSON file', async () => {
    const { encryptJSON, isEncrypted } = await import('../crypto')
    await encryptJSON({ data: true }, testFile)
    expect(await isEncrypted(testFile)).toBe(true)
  })

  it('returns true for encrypted media file', async () => {
    const { encryptFileInPlace, isEncrypted } = await import('../crypto')
    await fsWriteFile(testFile, nodeRandomBytes(100))
    await encryptFileInPlace(testFile)
    expect(await isEncrypted(testFile)).toBe(true)
  })

  it('returns false for plain JSON', async () => {
    const { isEncrypted } = await import('../crypto')
    await fsWriteFile(testFile, JSON.stringify({ plain: true }))
    expect(await isEncrypted(testFile)).toBe(false)
  })

  it('returns false for plain WebM (starts with 0x1A)', async () => {
    const { isEncrypted } = await import('../crypto')
    // WebM/EBML magic: 0x1A 0x45 0xDF 0xA3
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])
    await fsWriteFile(testFile, webmHeader)
    expect(await isEncrypted(testFile)).toBe(false)
  })

  it('returns false for nonexistent file', async () => {
    const { isEncrypted } = await import('../crypto')
    expect(await isEncrypted('/nonexistent/file')).toBe(false)
  })
})

describe('migrateRecordings', () => {
  const testDir = join(tmpdir(), 'autodoc-migrate-test')

  beforeEach(async () => {
    await mkdir(join(testDir, 'meeting-1'), { recursive: true })
  })

  afterEach(async () => {
    const { rm } = await import('fs/promises')
    await rm(testDir, { recursive: true, force: true })
  })

  it('encrypts unencrypted files and skips already-encrypted ones', async () => {
    const { encryptJSON, migrateRecordings, isEncrypted } = await import('../crypto')

    // Create an unencrypted transcript
    const transcriptPath = join(testDir, 'meeting-1', 'transcript.json')
    await fsWriteFile(transcriptPath, JSON.stringify([{ text: 'hello' }]))

    // Create an already-encrypted segments file
    const segmentsPath = join(testDir, 'meeting-1', 'segments.json')
    await encryptJSON({ decisions: [] }, segmentsPath)

    await migrateRecordings(testDir)

    expect(await isEncrypted(transcriptPath)).toBe(true)
    expect(await isEncrypted(segmentsPath)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: FAIL — `isEncrypted` and `migrateRecordings` not exported

- [ ] **Step 3: Implement isEncrypted and migrateRecordings**

Add to `crypto.ts`:

```ts
import { readdir, stat } from 'fs/promises'

export async function isEncrypted(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const buf = Buffer.alloc(4)
      const { bytesRead } = await handle.read(buf, 0, 4)
      if (bytesRead < 4) return false
      return buf.equals(MAGIC)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

const MEETING_FILES_MEDIA = ['audio.webm', 'screen.webm']
const MEETING_FILES_JSON = ['transcript.json', 'segments.json']

export async function migrateRecordings(recordingsBaseDir: string): Promise<void> {
  let dirs: string[]
  try {
    dirs = await readdir(recordingsBaseDir)
  } catch {
    return
  }

  for (const meetingId of dirs) {
    const meetingDir = join(recordingsBaseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    // Clean up stale .enc temps
    for (const name of MEETING_FILES_MEDIA) {
      const encTemp = join(meetingDir, name + '.enc')
      await fsUnlink(encTemp).catch(() => {})
    }

    // Encrypt unencrypted media files
    for (const name of MEETING_FILES_MEDIA) {
      const filePath = join(meetingDir, name)
      try {
        await stat(filePath)
      } catch { continue }
      if (await isEncrypted(filePath)) continue
      console.log(`Encrypting ${meetingId}/${name}`)
      await encryptFileInPlace(filePath)
    }

    // Encrypt unencrypted JSON files
    for (const name of MEETING_FILES_JSON) {
      const filePath = join(meetingDir, name)
      try {
        await stat(filePath)
      } catch { continue }
      if (await isEncrypted(filePath)) continue
      console.log(`Encrypting ${meetingId}/${name}`)
      const raw = await readFile(filePath, 'utf-8')
      const data = JSON.parse(raw)
      await encryptJSON(data, filePath)
    }
  }
}

export async function cleanupTempFiles(): Promise<void> {
  const tmpDir = tmpdir()
  try {
    const files = await readdir(tmpDir)
    for (const file of files) {
      if (file.startsWith('autodoc-') && file.endsWith('.tmp')) {
        await fsUnlink(join(tmpDir, file)).catch(() => {})
      }
    }
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts src/main/services/__tests__/crypto.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/crypto.ts src/main/services/__tests__/crypto.test.ts
git commit -m "feat(crypto): add isEncrypted detection and migration helper"
```

---

### Task 5: Integrate Encryption into Recording Pipeline

**Files:**
- Modify: `src/main/ipc/recording-ipc.ts:72-76` — make stop handler async, add encryption

- [ ] **Step 1: Update the recording:stop handler**

In `src/main/ipc/recording-ipc.ts`, change the `recording:stop` handler:

```ts
// Before (line 72-76):
ipcMain.handle('recording:stop', () => {
  const result = recordingService.stopRecording()
  broadcastState(recordingService.getState())
  transcriptionService.enqueue(result.meetingId)
  return result
})

// After:
ipcMain.handle('recording:stop', () => {
  const result = recordingService.stopRecording()
  broadcastState(recordingService.getState())

  // Fire-and-forget: encrypt then enqueue transcription
  // Don't await — return result to renderer immediately
  ;(async () => {
    // Allow in-flight save-chunk IPCs to settle before encrypting
    await new Promise((resolve) => setTimeout(resolve, 100))

    const baseDir = recordingService.getRecordingsBaseDir()
    const audioPath = join(baseDir, result.meetingId, 'audio.webm')
    const videoPath = join(baseDir, result.meetingId, 'screen.webm')

    try {
      await encryptFileInPlace(audioPath)
    } catch (err) {
      console.error('Failed to encrypt audio:', err)
    }
    try {
      await encryptFileInPlace(videoPath)
    } catch (err) {
      console.error('Failed to encrypt video:', err)
    }

    transcriptionService.enqueue(result.meetingId)
  })()

  return result
})
```

Add import at the top of the file:

```ts
import { encryptFileInPlace } from '../services/crypto'
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/recording-ipc.ts
git commit -m "feat(recording): encrypt media files after recording stops"
```

---

### Task 6: Integrate Encryption into Transcription Pipeline

**Files:**
- Modify: `src/main/services/transcription.ts:62-69` — `getTranscript` uses `decryptJSON`
- Modify: `src/main/services/transcription.ts:121-156` — `processJob` decrypts audio to tmpdir, writes encrypted transcript

- [ ] **Step 1: Update transcription.ts**

Add imports at the top:

```ts
import { tmpdir } from 'os'
import { encryptJSON, decryptJSON, decryptFileToTemp, isEncrypted } from './crypto'
```

Change `getTranscript` (lines 62-69):

```ts
// Before:
async getTranscript(meetingId: string): Promise<Transcript[]> {
  const transcriptPath = join(this.recordingsBaseDir, meetingId, 'transcript.json')
  try {
    const data = await readFile(transcriptPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

// After:
async getTranscript(meetingId: string): Promise<Transcript[]> {
  const transcriptPath = join(this.recordingsBaseDir, meetingId, 'transcript.json')
  try {
    if (await isEncrypted(transcriptPath)) {
      return await decryptJSON<Transcript[]>(transcriptPath)
    }
    const data = await readFile(transcriptPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}
```

Change `processJob` (lines 121-156). Key changes:
1. Decrypt audio.webm to a temp file
2. Write intermediate wav + whisper output to tmpdir
3. Write encrypted transcript.json

```ts
private async processJob(meetingId: string): Promise<void> {
  const meetingDir = join(this.recordingsBaseDir, meetingId)
  const audioWebm = join(meetingDir, 'audio.webm')
  const transcriptPath = join(meetingDir, 'transcript.json')

  if (!(await this.fileExists(audioWebm))) {
    return
  }

  if (!(await this.whisperManager.isReady())) {
    this.activeStatus = 'downloading'
    this.broadcastStatus(meetingId, 'downloading')
    await this.whisperManager.ensureReady()
  }

  this.activeStatus = 'transcribing'
  this.broadcastStatus(meetingId, 'transcribing')

  // Decrypt audio to temp if encrypted, otherwise use directly
  let audioInput = audioWebm
  let decryptedTemp: string | null = null
  if (await isEncrypted(audioWebm)) {
    decryptedTemp = await decryptFileToTemp(audioWebm)
    audioInput = decryptedTemp
  }

  // Write intermediate files to tmpdir
  const tmpBase = `autodoc-${meetingId.slice(0, 8)}-${Date.now()}`
  const audioWav = join(tmpdir(), `${tmpBase}.wav`)
  const whisperJsonOutput = join(tmpdir(), `${tmpBase}.wav.json`)

  try {
    await this.audioConverter.convert(
      audioInput,
      audioWav,
      this.whisperManager.getFfmpegPath()
    )

    await this.runWhisper(audioWav)

    // Whisper writes output as {input}.json
    const whisperJson = await readFile(whisperJsonOutput, 'utf-8')
    const whisperOutput: WhisperOutput = JSON.parse(whisperJson)
    const transcripts = this.mapToTranscripts(meetingId, whisperOutput)

    await encryptJSON(transcripts, transcriptPath)
  } finally {
    // Clean up all temp files
    if (decryptedTemp) await unlink(decryptedTemp).catch(() => {})
    await unlink(audioWav).catch(() => {})
    await unlink(whisperJsonOutput).catch(() => {})
  }

  this.activeStatus = 'complete'
  this.broadcastStatus(meetingId, 'complete')
  this.onCompleteCallback?.(meetingId)
}
```

**Note:** The `runWhisper` method passes `audioWavPath` with `-f` flag. Since the output filename is `{input}.json`, whisper will write to the tmpdir path + `.json`, which is our `whisperJsonOutput` variable. Verify the whisper output path matches: whisper writes to `audioWav + '.json'` which equals `whisperJsonOutput`.

- [ ] **Step 2: Update existing transcription tests**

The existing `transcription.test.ts` mocks `fs/promises` but not `./crypto`. Since `getTranscript` now calls `isEncrypted` (which uses `fs.open`), the tests will break. Mock the crypto module in the test:

Add at the top of `src/main/services/__tests__/transcription.test.ts`:

```ts
vi.mock('../crypto', () => ({
  isEncrypted: vi.fn().mockResolvedValue(false),
  decryptJSON: vi.fn(),
  decryptFileToTemp: vi.fn(),
  encryptJSON: vi.fn(),
}))
```

This ensures existing tests continue testing the non-encrypted path. The crypto module's own tests (Task 2-4) cover the encryption logic.

- [ ] **Step 3: Run tests**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/services/transcription.ts src/main/services/__tests__/transcription.test.ts
git commit -m "feat(transcription): use encrypted file I/O for audio and transcripts"
```

---

### Task 7: Integrate Encryption into Segmentation Pipeline

**Files:**
- Modify: `src/main/services/segmentation.ts:47-59` — `getSegments` and `saveSegments` use crypto
- Modify: `src/main/services/segmentation.ts:102-129` — `processJob` uses crypto

- [ ] **Step 1: Update segmentation.ts**

Add import at the top:

```ts
import { encryptJSON, decryptJSON, isEncrypted } from './crypto'
```

Change `getSegments` (lines 47-55):

```ts
// After:
async getSegments(meetingId: string): Promise<MeetingSegments | null> {
  const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
  try {
    if (await isEncrypted(segmentsPath)) {
      return await decryptJSON<MeetingSegments>(segmentsPath)
    }
    const data = await readFile(segmentsPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}
```

Change `saveSegments` (line ~59):

```ts
// After:
async saveSegments(meetingId: string, segments: MeetingSegments): Promise<void> {
  const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
  await encryptJSON(segments, segmentsPath)
}
```

Change `processJob` (lines 102-129). The transcript read and segments write need crypto:

```ts
private async processJob(meetingId: string): Promise<void> {
  const meetingDir = join(this.recordingsBaseDir, meetingId)
  const transcriptPath = join(meetingDir, 'transcript.json')
  const segmentsPath = join(meetingDir, 'segments.json')

  if (!(await this.fileExists(transcriptPath))) {
    return
  }

  this.activeStatus = 'downloading-model'
  this.broadcastStatus(meetingId, 'downloading-model')
  await this.ollamaManager.waitUntilReady()

  this.activeStatus = 'segmenting'
  this.broadcastStatus(meetingId, 'segmenting')

  // Read transcript — handle both encrypted and legacy formats
  let transcripts: Transcript[]
  if (await isEncrypted(transcriptPath)) {
    transcripts = await decryptJSON<Transcript[]>(transcriptPath)
  } else {
    const transcriptData = await readFile(transcriptPath, 'utf-8')
    transcripts = JSON.parse(transcriptData)
  }

  const fullText = transcripts.map((t) => `[${t.speaker}] ${t.text}`).join('\n')

  const segments = await this.llmProvider.summarize(meetingId, fullText)

  await encryptJSON(segments, segmentsPath)

  this.activeStatus = 'complete'
  this.broadcastStatus(meetingId, 'complete')
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/services/segmentation.ts
git commit -m "feat(segmentation): use encrypted file I/O for segments and transcripts"
```

---

### Task 8: Integrate Encryption into Search & Chat IPC

**Files:**
- Modify: `src/main/ipc/search-ipc.ts:35-58` — replace `readFile` with `decryptJSON`
- Modify: `src/main/ipc/chat-ipc.ts:87-108` — replace `readFile` with `decryptJSON`

- [ ] **Step 1: Update search-ipc.ts**

Add import:

```ts
import { decryptJSON, isEncrypted } from '../services/crypto'
```

Replace the transcript search block (lines 35-44):

```ts
// Before:
try {
  const data = await readFile(join(meetingDir, 'transcript.json'), 'utf-8')
  const transcripts: Transcript[] = JSON.parse(data)

// After:
try {
  const tPath = join(meetingDir, 'transcript.json')
  const transcripts: Transcript[] = await isEncrypted(tPath)
    ? await decryptJSON<Transcript[]>(tPath)
    : JSON.parse(await readFile(tPath, 'utf-8'))
```

Replace the segments search block (lines 47-58):

```ts
// Before:
try {
  const data = await readFile(join(meetingDir, 'segments.json'), 'utf-8')
  const segments: MeetingSegments = JSON.parse(data)

// After:
try {
  const sPath = join(meetingDir, 'segments.json')
  const segments: MeetingSegments = await isEncrypted(sPath)
    ? await decryptJSON<MeetingSegments>(sPath)
    : JSON.parse(await readFile(sPath, 'utf-8'))
```

- [ ] **Step 2: Update chat-ipc.ts**

Add import:

```ts
import { decryptJSON, isEncrypted } from '../services/crypto'
```

Replace segment reading in `gatherMeetingContext` (lines 87-97):

```ts
// Before:
try {
  const data = await readFile(join(meeting.dir, 'segments.json'), 'utf-8')
  const segments: MeetingSegments = JSON.parse(data)

// After:
try {
  const sPath = join(meeting.dir, 'segments.json')
  const segments: MeetingSegments = await isEncrypted(sPath)
    ? await decryptJSON<MeetingSegments>(sPath)
    : JSON.parse(await readFile(sPath, 'utf-8'))
```

Replace transcript reading fallback (lines 100-105):

```ts
// Before:
try {
  const data = await readFile(join(meeting.dir, 'transcript.json'), 'utf-8')
  const transcripts: Transcript[] = JSON.parse(data)

// After:
try {
  const tPath = join(meeting.dir, 'transcript.json')
  const transcripts: Transcript[] = await isEncrypted(tPath)
    ? await decryptJSON<Transcript[]>(tPath)
    : JSON.parse(await readFile(tPath, 'utf-8'))
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/search-ipc.ts src/main/ipc/chat-ipc.ts
git commit -m "feat(search,chat): read encrypted transcript and segment files"
```

---

### Task 9: Integrate Encryption into Media Protocol Handler + Startup Migration

**Files:**
- Modify: `src/main/index.ts:94-102` — media protocol handler with decrypt stream
- Modify: `src/main/index.ts:167-168` — add migration call at startup

- [ ] **Step 1: Update the media protocol handler in index.ts**

Add import at the top:

```ts
import { isEncrypted, createDecryptStream, migrateRecordings, cleanupTempFiles } from './services/crypto'
```

Replace the protocol handler (lines 95-102):

```ts
// Before:
protocol.handle('autodoc-media', (request) => {
  const url = new URL(request.url)
  const meetingId = url.hostname
  const filename = url.pathname.slice(1)
  const filePath = join(recordingService.getRecordingsBaseDir(), meetingId, filename)
  return net.fetch(`file://${filePath}`)
})

// After:
protocol.handle('autodoc-media', async (request) => {
  const url = new URL(request.url)
  const meetingId = url.hostname
  const filename = url.pathname.slice(1)
  const filePath = join(recordingService.getRecordingsBaseDir(), meetingId, filename)

  if (await isEncrypted(filePath)) {
    const stream = createDecryptStream(filePath)
    const mimeType = filename.endsWith('.webm') ? 'video/webm' : 'application/octet-stream'
    return new Response(stream as unknown as ReadableStream, {
      headers: { 'Content-Type': mimeType },
    })
  }

  return net.fetch(`file://${filePath}`)
})
```

**Note on stream typing:** Node.js `Readable` is not directly a web `ReadableStream`. In Electron's `protocol.handle`, the `Response` constructor accepts Node streams. If there is a type error, wrap with `Readable.toWeb(stream)`:

```ts
import { Readable } from 'stream'
// ...
return new Response(Readable.toWeb(stream) as ReadableStream, { ... })
```

- [ ] **Step 2: Add migration and temp cleanup at startup**

After the existing `segmentationService.scanAndEnqueuePending()` call (line ~168), add:

```ts
// Encrypt any pre-existing unencrypted recordings
cleanupTempFiles().catch(() => {})
migrateRecordings(recordingService.getRecordingsBaseDir()).catch((err) => {
  console.error('Migration failed:', err)
})
```

- [ ] **Step 3: Run full test suite and type-check**

Run: `npx vitest run --config vitest.main.config.mts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(media,migration): decrypt media streams and migrate unencrypted files at startup"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All PASS

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test checklist**

1. Start the app. Check console for migration logs (existing recordings should get encrypted).
2. Open a meeting recording — video/audio should play. Transcript should load. Notes should display and be editable.
3. Search for a term — results from encrypted files should appear.
4. Ask AI a question — should pull context from encrypted transcripts.
5. Start a new recording, stop it. Verify the `.webm` files in `~/AutoDoc/recordings/{id}/` start with `ADOC` bytes.
6. Open the new recording — media plays, transcription runs, segmentation runs.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during encryption smoke testing"
```
