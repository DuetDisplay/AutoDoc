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
- Encrypt via `safeStorage.encryptString()` and store in `electron-store` under key `encryption_key`.
- On subsequent launches, load and decrypt. Export `getKey(): Buffer`.
- If `safeStorage` is unavailable (rare Linux edge case), fall back to storing the key in plaintext in electron-store and log a warning.

### JSON Encrypt/Decrypt (small files)

- `encryptJSON(data: unknown, filePath: string): Promise<void>` — serialize to JSON, encrypt with AES-256-GCM, write to file.
- `decryptJSON<T>(filePath: string): Promise<T>` — read file, decrypt, parse JSON.
- **File format:** `[12-byte IV][16-byte auth tag][ciphertext]` — 28-byte header + ciphertext.
- IV is randomly generated per write.

### Chunked Media Encrypt/Decrypt (large files)

For audio/video files that may be hundreds of MB.

- `encryptFileInPlace(plainPath: string): Promise<void>` — encrypt to `.enc` temp, atomic rename.
- `decryptFileToTemp(encPath: string): Promise<string>` — decrypt to OS temp dir, return path. Caller responsible for cleanup.
- `createDecryptStream(encPath: string): Readable` — streaming block-by-block decryption for media serving.

**Chunked file format:**

```
[1 byte: version = 0x01]
[12 bytes: base nonce]
[block 0: 16-byte GCM tag | up to 65536 bytes ciphertext]
[block 1: 16-byte GCM tag | up to 65536 bytes ciphertext]
...
[final block: 16-byte GCM tag | remaining ciphertext]
```

- Block size: 64KB (65,536 bytes) of plaintext per block.
- Each block's IV: `base_nonce XOR block_index` (index as 4-byte big-endian in the last 4 bytes of the nonce).
- The GCM tag precedes the ciphertext in each block so we can read tag + ciphertext together.

### Migration Helper

- `isEncrypted(filePath: string): Promise<boolean>` — reads first byte; if `0x01` (version byte for chunked) or first 28 bytes match JSON encrypted header pattern, return true.
- For JSON files: attempt `decryptJSON` first; if it fails with a decryption error, treat as unencrypted (legacy).

## Integration Points

### Recording Pipeline

**`recording-ipc.ts` / `recording.ts`:**

- `save-chunk`: No change — chunks append as plaintext during active recording.
- `recording:stop`: After `stopRecording()`, encrypt both `audio.webm` and `screen.webm` in place via `encryptFileInPlace`. Transcription is enqueued only after encryption completes.
- Broadcast a status update so the UI knows encryption is in progress (use existing `recording:status-changed` with a brief processing state, or just let it be transparent since encryption of a typical file takes < 1 second).

### Transcription Pipeline (`transcription.ts`)

- Before ffmpeg: call `decryptFileToTemp('audio.webm')` → get temp WAV path → ffmpeg converts → whisper runs → delete temp files.
- Write `transcript.json` via `encryptJSON` instead of `writeFile`.
- Read `transcript.json` via `decryptJSON` instead of `readFile`.

### Segmentation Pipeline (`segmentation.ts`)

- Read/write `segments.json` via `encryptJSON`/`decryptJSON`.
- Read `transcript.json` via `decryptJSON` for LLM context.

### Search & Chat IPC (`search-ipc.ts`, `chat-ipc.ts`)

- All `readFile` calls for `transcript.json` and `segments.json` replaced with `decryptJSON`.

### Media Protocol Handler (`index.ts`)

- `autodoc-media://` handler: replace `net.fetch(file://)` with `createDecryptStream(filePath)`.
- Return a `new Response(stream, { headers: { 'Content-Type': 'video/webm' } })`.
- Handle unencrypted legacy files: if `isEncrypted` returns false, fall back to `net.fetch`.

### Startup Migration

On app startup (after `app.whenReady`, in background):

1. Scan all meeting directories in the recordings base dir.
2. For each file (`audio.webm`, `screen.webm`, `transcript.json`, `segments.json`):
   - If file exists and `isEncrypted` returns false, encrypt in place.
3. Run in background, non-blocking. Log progress.
4. Clean up any stale `.enc` temp files (from interrupted previous encryptions).
5. Clean up any `autodoc-*.tmp` files in `os.tmpdir()`.

## Error Handling

| Scenario | Handling |
|----------|----------|
| **Key loss** (keychain entry deleted) | Data is unrecoverable. Show warning in Settings that encryption is tied to OS account. Document in README. |
| **Crash during encrypt-in-place** | Encrypt to `.enc` temp first, then atomic rename. If `.enc` temp found on startup, delete it and re-encrypt from original. |
| **Crash during decrypt-to-temp** | Temp files in `os.tmpdir()` with `autodoc-` prefix. Cleaned up on app start. |
| **Pre-existing unencrypted files** | Migration handles on startup. `isEncrypted` check means both formats coexist during transition. |
| **safeStorage unavailable** | Fall back to plaintext key storage with console warning. Encryption still works, just key is less protected. |

## Files Changed

| File | Change |
|------|--------|
| `src/main/services/crypto.ts` | **New** — key management, encrypt/decrypt functions |
| `src/main/services/recording.ts` | Import crypto, encrypt files after stop |
| `src/main/ipc/recording-ipc.ts` | Call encrypt after stop, before enqueuing transcription |
| `src/main/services/transcription.ts` | Decrypt audio to temp, encrypt/decrypt JSON |
| `src/main/services/segmentation.ts` | Encrypt/decrypt JSON |
| `src/main/ipc/search-ipc.ts` | Use `decryptJSON` |
| `src/main/ipc/chat-ipc.ts` | Use `decryptJSON` |
| `src/main/index.ts` | Media protocol decrypt stream, startup migration |

No renderer changes — encryption is fully transparent to the frontend.

## Testing Strategy

- **Unit tests for crypto module:** Round-trip encrypt/decrypt for JSON and chunked formats. Verify `isEncrypted` detection. Verify corrupt data throws.
- **Integration tests:** Recording → encrypt → transcription pipeline works end-to-end. Media streaming serves decrypted content.
- **Migration test:** Place unencrypted files, run migration, verify they become encrypted and remain readable.
