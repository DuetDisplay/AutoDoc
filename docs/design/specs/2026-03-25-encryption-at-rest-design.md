# Encryption at Rest for AutoDoc Local Recordings

**Date:** 2026-03-25
**Status:** Approved

## Overview

All meeting data stored on disk (audio, video, transcripts, segments) is encrypted using AES-256-GCM with a per-user key stored in the OS keychain via Electron's `safeStorage`. Being open source does not weaken this — security comes from the key, not code secrecy.

## Threat Model

- **Primary threat:** Stolen/accessed laptop or file exfiltration. An attacker who copies the recordings directory gets ciphertext.
- **Not in scope:** Protecting data while the app is actively recording (user is present) or from a fully compromised OS account (attacker has keychain access).

## Crypto Module — `src/main/services/crypto.ts`

Single module that all encrypted I/O routes through.

### Key Management

- On first launch, generate 32 random bytes (`crypto.randomBytes(32)`).
- Base64-encode the key, then encrypt via `safeStorage.encryptString(base64Key)`. Store the encrypted buffer in `electron-store` under key `encryption_key` (using `latin1` encoding, matching existing `token-store.ts` pattern). Store a `encryption_key_version: 1` alongside it for future-proofing.
- On subsequent launches, load the encrypted buffer, `safeStorage.decryptString()`, base64-decode back to a 32-byte Buffer. Export `getKey(): Buffer`.
- If `safeStorage` is unavailable (rare Linux edge case), fall back to storing the base64 key in plaintext in electron-store and log a warning.

### JSON Encrypt/Decrypt (small files)

- `encryptJSON(data: unknown, filePath: string): Promise<void>` — serialize to JSON, encrypt with AES-256-GCM, write to file.
- `decryptJSON<T>(filePath: string): Promise<T>` — read file, decrypt, parse JSON.
- **File format:** `[4-byte magic: ADOC][12-byte IV][16-byte auth tag][ciphertext]` — 32-byte header + ciphertext.
- IV is randomly generated via `crypto.randomBytes(12)` per write.
- AAD: the filename (basename only, e.g., `transcript.json`) to bind ciphertext to its intended file.

### Chunked Media Encrypt/Decrypt (large files)

For audio/video files that may be hundreds of MB.

- `encryptFileInPlace(plainPath: string): Promise<void>` — encrypt to `.enc` temp, atomic rename.
- `decryptFileToTemp(encPath: string): Promise<string>` — decrypt to OS temp dir (`autodoc-` prefix), return path. Caller responsible for cleanup.
- `createDecryptStream(encPath: string): Readable` — streaming block-by-block decryption for media serving.

**Chunked file format:**

```
[4 bytes: magic = "ADOC" (0x41 0x44 0x4F 0x43)]
[1 byte: version = 0x01]
[12 bytes: base nonce (randomly generated via crypto.randomBytes(12))]
[block 0: 16-byte GCM tag | up to 65536 bytes ciphertext]
[block 1: 16-byte GCM tag | up to 65536 bytes ciphertext]
...
[final block: 16-byte GCM tag | remaining ciphertext]
```

- Block size: 64KB (65,536 bytes) of plaintext per block.
- **Base nonce:** Generated via `crypto.randomBytes(12)` per `encryptFileInPlace` call. Must be unique per file.
- Each block's IV: `base_nonce XOR block_index` (index as 4-byte big-endian in the last 4 bytes of the 12-byte nonce). Supports files up to 256 TB.
- **AAD per block:** 4-byte big-endian block index, binding each block to its position. Prevents block reordering/swapping.
- The GCM tag precedes the ciphertext in each block so we can read tag + ciphertext together.

### Encrypted File Detection

- `isEncrypted(filePath: string): Promise<boolean>` — reads first 4 bytes; returns true if they match the `ADOC` magic (`0x41 0x44 0x4F 0x43`). This is unambiguous: WebM starts with `0x1A 0x45 0xDF 0xA3`, JSON starts with `{` or `[`.
- For JSON files during migration: if `isEncrypted` returns false, attempt `JSON.parse` on the raw content. If it succeeds, the file is unencrypted legacy.

## Integration Points

### Recording Pipeline

**`recording-ipc.ts`** (owns the encrypt-after-stop orchestration):

- `save-chunk`: No change — chunks append as plaintext during active recording.
- `recording:stop`: After `stopRecording()`, the handler becomes `async`. It must `await encryptFileInPlace` for both `audio.webm` and `screen.webm` before enqueuing transcription.
- **Chunk finalization race:** After `stopRecording()` clears the recording state, the existing guard in `save-chunk` (checks `currentState.isRecording`) rejects any in-flight chunks. Add a 100ms delay before starting encryption to allow any in-flight IPC to settle.
- Encryption of typical files (~360MB audio, ~900MB video) takes < 1 second on modern hardware (Node.js AES-256-GCM throughput ~1GB/s).

### Transcription Pipeline (`transcription.ts`)

- Before ffmpeg: call `decryptFileToTemp('audio.webm')` → get decrypted temp path → ffmpeg converts to WAV in `os.tmpdir()` (not the meeting directory) → whisper runs with output also in `os.tmpdir()` → read whisper JSON → delete all temp files.
- **Key change:** Intermediate files (`audio.wav`, `audio.wav.json`) must be written to `os.tmpdir()` with `autodoc-` prefix, NOT the meeting directory. This prevents plaintext leaking to disk on crash. Requires adjusting the ffmpeg output path and whisper `-f` input path.
- Write `transcript.json` via `encryptJSON` instead of `writeFile`.
- Read `transcript.json` via `decryptJSON` instead of `readFile`.

### Segmentation Pipeline (`segmentation.ts`)

- Read/write `segments.json` via `encryptJSON`/`decryptJSON`.
- Read `transcript.json` via `decryptJSON` for LLM context.

### Search & Chat IPC (`search-ipc.ts`, `chat-ipc.ts`)

- All `readFile` calls for `transcript.json` and `segments.json` replaced with `decryptJSON`.

### Media Protocol Handler (`index.ts`)

- `autodoc-media://` handler: check `isEncrypted(filePath)`. If encrypted, use `createDecryptStream(filePath)` and return `new Response(stream, { headers: { 'Content-Type': 'video/webm' } })`. If unencrypted (legacy), fall back to `net.fetch(file://)`.

### Error Files

- `transcript.error` and `segments.error` contain only error messages/stack traces, no meeting content. They are **not encrypted** — this is intentional so they can be read for debugging without the key. The error messages written in `transcription.ts` and `segmentation.ts` must NOT include transcript content (currently they only include external tool error output, which is safe).

### Startup Migration

On app startup (after `app.whenReady`, in background):

1. Clean up any stale `.enc` temp files in meeting directories (from interrupted previous encryptions — delete the `.enc` file, the original is still intact).
2. Clean up any `autodoc-*.tmp` files in `os.tmpdir()`.
3. Scan all meeting directories in the recordings base dir.
4. For each file (`audio.webm`, `screen.webm`, `transcript.json`, `segments.json`):
   - If file exists and `isEncrypted` returns false, encrypt in place.
5. Run in background, non-blocking. Log progress.

## Error Handling

| Scenario | Handling |
|----------|----------|
| **Key loss** (keychain entry deleted) | Data is unrecoverable. Show warning in Settings that encryption is tied to OS account. Document in README. |
| **Crash during encrypt-in-place** | Encrypt to `.enc` temp first, then atomic rename. If `.enc` temp found on startup, original is still intact — delete the `.enc` and re-encrypt. |
| **Crash during decrypt-to-temp** | Temp files in `os.tmpdir()` with `autodoc-` prefix. Cleaned up on app start. |
| **Pre-existing unencrypted files** | Migration handles on startup. `isEncrypted` check means both formats coexist during transition. |
| **safeStorage unavailable** | Fall back to plaintext key storage with console warning. Encryption still works, just key is less protected. |

## Files Changed

| File | Change |
|------|--------|
| `src/main/services/crypto.ts` | **New** — key management, encrypt/decrypt, detect, migrate |
| `src/main/ipc/recording-ipc.ts` | Async stop handler, encrypt after stop, 100ms settle delay |
| `src/main/services/transcription.ts` | Decrypt audio to tmpdir, intermediate files in tmpdir, encrypt/decrypt JSON |
| `src/main/services/segmentation.ts` | Encrypt/decrypt JSON |
| `src/main/ipc/search-ipc.ts` | Use `decryptJSON` |
| `src/main/ipc/chat-ipc.ts` | Use `decryptJSON` |
| `src/main/index.ts` | Media protocol decrypt stream, startup migration |

No renderer changes — encryption is fully transparent to the frontend.

## Testing Strategy

- **Unit tests for crypto module:** Round-trip encrypt/decrypt for JSON and chunked formats. Verify `isEncrypted` detection with ADOC magic. Verify corrupt/tampered data throws. Verify block reordering is detected via AAD. Verify base64 key round-trip through safeStorage mock.
- **Integration tests:** Recording → encrypt → transcription pipeline works end-to-end. Media streaming serves decrypted content. Search/chat can read encrypted files.
- **Migration test:** Place unencrypted files, run migration, verify they become encrypted and remain readable.

## Future Work (out of scope for v1)

- **Key rotation:** Re-encrypt all data with a new key if compromise is suspected.
- **Export/backup:** Ability to decrypt and export meeting data.
