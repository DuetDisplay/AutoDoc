# Transcription Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically transcribe meeting recordings using a local whisper.cpp CLI, with results displayed in the app.

**Architecture:** When a recording stops, a TranscriptionService enqueues a job. It downloads whisper.cpp + ffmpeg + model on first use, converts WebM audio to WAV via ffmpeg, runs whisper.cpp CLI, parses JSON output into Transcript segments, and writes them to the recording directory. The renderer shows live transcription status on recording cards and displays transcripts on the meeting detail page.

**Tech Stack:** whisper.cpp CLI (prebuilt binary), ffmpeg (prebuilt binary), Node.js child_process for spawning, existing Electron IPC pattern, React + Zustand for renderer state.

---

## File Structure

### New Files (Main Process)
- `src/main/services/whisper-manager.ts` — Downloads and manages whisper.cpp binary, ffmpeg binary, and model file
- `src/main/services/audio-converter.ts` — Converts WebM/Opus to 16kHz mono WAV via ffmpeg
- `src/main/services/transcription.ts` — Job queue that orchestrates transcription end-to-end
- `src/main/ipc/transcription-ipc.ts` — IPC handlers for transcription channels
- `src/main/services/__tests__/whisper-manager.test.ts` — WhisperManager unit tests
- `src/main/services/__tests__/audio-converter.test.ts` — AudioConverter unit tests
- `src/main/services/__tests__/transcription.test.ts` — TranscriptionService unit tests

### New Files (Renderer)
- `src/renderer/src/components/TranscriptionBadge.tsx` — Status badge component for recording cards
- `src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx` — Badge tests
- `src/renderer/src/components/TranscriptView.tsx` — Transcript display for meeting detail page
- `src/renderer/src/components/__tests__/TranscriptView.test.tsx` — TranscriptView tests

### Modified Files
- `src/shared/types.ts` — Add `TranscriptionStatus` type, add `transcriptionStatus` to `RecordingEntry`
- `src/shared/constants.ts` — Add `MODELS_SUBDIR` constant
- `src/preload/ipc.d.ts` — Add transcription IPC channels and events
- `src/main/ipc/recording-ipc.ts` — Accept TranscriptionService, enqueue on stop, include status in list
- `src/main/index.ts` — Instantiate TranscriptionService, register transcription IPC, trigger re-enqueue on launch
- `src/renderer/src/pages/Recordings.tsx` — Use TranscriptionBadge, listen for live status updates
- `src/renderer/src/pages/MeetingDetail.tsx` — Show transcript in Transcript tab

---

### Task 1: Types, Constants, and IPC Definitions

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/preload/ipc.d.ts`

- [ ] **Step 1: Add TranscriptionStatus type and update RecordingEntry in types.ts**

Append after the `RecordingPaths` interface:

```typescript
export type TranscriptionStatus =
  | 'pending'
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'complete'
  | 'failed'
```

Update the existing `RecordingEntry` interface to add `transcriptionStatus`:

```typescript
export interface RecordingEntry {
  meetingId: string
  title: string
  date: number
  duration: number | null
  hasVideo: boolean
  hasAudio: boolean
  transcriptionStatus: TranscriptionStatus
}
```

- [ ] **Step 2: Add MODELS_SUBDIR constant to constants.ts**

Add after `RECORDING_SUBDIR` (line 34):

```typescript
export const MODELS_SUBDIR = 'models'
```

- [ ] **Step 3: Add transcription IPC channels to preload/ipc.d.ts**

Update the import line:

```typescript
import type { CalendarEvent, RecordingEntry, RecordingSource, RecordingState, RecordingPaths, Transcript, TranscriptionStatus } from '../shared/types'
```

Add to `IpcInvokeEvents`:

```typescript
  'transcription:get-status': [meetingId: string]
  'transcription:get-transcript': [meetingId: string]
  'transcription:retry': [meetingId: string]
```

Add to `IpcInvokeReturns`:

```typescript
  'transcription:get-status': TranscriptionStatus
  'transcription:get-transcript': Transcript[]
  'transcription:retry': void
```

Add to `IpcOnEvents`:

```typescript
  'transcription:status-changed': [payload: { meetingId: string; status: TranscriptionStatus }]
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Type errors in `recording-ipc.ts` because `RecordingEntry` now requires `transcriptionStatus` — this is expected and will be fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts src/preload/ipc.d.ts
git commit -m "feat(transcription): add TranscriptionStatus type, MODELS_SUBDIR constant, and IPC channels"
```

---

### Task 2: WhisperManager

**Files:**
- Create: `src/main/services/whisper-manager.ts`
- Test: `src/main/services/__tests__/whisper-manager.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/main/services/__tests__/whisper-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WhisperManager } from '../whisper-manager'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home'),
  },
}))

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}))

const mockAccess = vi.mocked(await import('fs/promises')).access

describe('WhisperManager', () => {
  let manager: WhisperManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new WhisperManager()
  })

  it('returns correct models directory path', () => {
    expect(manager.getModelsDir()).toBe('/mock/home/AutoDoc/models')
  })

  it('returns correct whisper binary path', () => {
    expect(manager.getWhisperPath()).toBe('/mock/home/AutoDoc/models/whisper-cpp')
  })

  it('returns correct ffmpeg binary path', () => {
    expect(manager.getFfmpegPath()).toBe('/mock/home/AutoDoc/models/ffmpeg')
  })

  it('returns correct model path', () => {
    expect(manager.getModelPath()).toBe('/mock/home/AutoDoc/models/ggml-large-v3.bin')
  })

  it('reports ready when all files exist', async () => {
    mockAccess.mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(true)
    expect(mockAccess).toHaveBeenCalledTimes(3)
  })

  it('reports not ready when whisper binary is missing', async () => {
    mockAccess
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })

  it('reports not ready when model is missing', async () => {
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(undefined)
    const ready = await manager.isReady()
    expect(ready).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: FAIL — `whisper-manager` module not found

- [ ] **Step 3: Implement WhisperManager**

Create `src/main/services/whisper-manager.ts`:

```typescript
import { app } from 'electron'
import { access, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { createWriteStream } from 'fs'
import { EventEmitter } from 'events'
import { RECORDING_DIR_NAME, MODELS_SUBDIR } from '../../shared/constants'

export interface DownloadProgress {
  file: string
  percent: number
  bytesDownloaded: number
  bytesTotal: number
}

export class WhisperManager extends EventEmitter {
  getModelsDir(): string {
    return join(app.getPath('home'), RECORDING_DIR_NAME, MODELS_SUBDIR)
  }

  getWhisperPath(): string {
    return join(this.getModelsDir(), 'whisper-cpp')
  }

  getFfmpegPath(): string {
    return join(this.getModelsDir(), 'ffmpeg')
  }

  getModelPath(): string {
    return join(this.getModelsDir(), 'ggml-large-v3.bin')
  }

  async isReady(): Promise<boolean> {
    try {
      await access(this.getWhisperPath())
      await access(this.getModelPath())
      await access(this.getFfmpegPath())
      return true
    } catch {
      return false
    }
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.getModelsDir(), { recursive: true })

    if (!(await this.fileExists(this.getWhisperPath()))) {
      await this.downloadWithRetry(() => this.downloadWhisper(), 'whisper-cpp')
    }
    if (!(await this.fileExists(this.getFfmpegPath()))) {
      await this.downloadWithRetry(() => this.downloadFfmpeg(), 'ffmpeg')
    }
    if (!(await this.fileExists(this.getModelPath()))) {
      await this.downloadWithRetry(() => this.downloadModel(), 'model')
    }
  }

  private async downloadWithRetry(fn: () => Promise<void>, label: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await fn()
        return
      } catch (err) {
        if (i === attempts - 1) throw err
        const delay = Math.pow(2, i) * 1000 // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  private async downloadWhisper(): Promise<void> {
    // NOTE: The exact URL must be verified against the latest whisper.cpp GitHub Release
    // for the current platform. The release asset naming varies between versions.
    // Check https://github.com/ggerganov/whisper.cpp/releases for current names.
    const url = this.getWhisperDownloadUrl()
    await this.downloadFile(url, this.getWhisperPath(), 'whisper-cpp')
    await chmod(this.getWhisperPath(), 0o755)
  }

  private async downloadFfmpeg(): Promise<void> {
    // evermeet.cx provides raw binary downloads at /ffmpeg/getrelease/zip
    // We download the zip and extract the ffmpeg binary.
    // Alternative: use ffmpeg-static npm package at build time.
    const url = this.getFfmpegDownloadUrl()
    const zipPath = this.getFfmpegPath() + '.zip'
    await this.downloadFile(url, zipPath, 'ffmpeg')
    // Extract using built-in unzip (macOS has it)
    const { execSync } = await import('child_process')
    execSync(`unzip -o -j "${zipPath}" -d "${this.getModelsDir()}"`)
    await chmod(this.getFfmpegPath(), 0o755)
    // Clean up zip
    const { unlink } = await import('fs/promises')
    await unlink(zipPath).catch(() => {})
  }

  private async downloadModel(): Promise<void> {
    const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin'
    await this.downloadFile(url, this.getModelPath(), 'ggml-large-v3.bin')
  }

  private getWhisperDownloadUrl(): string {
    const platform = process.platform
    const arch = process.arch
    if (platform === 'darwin' && arch === 'arm64') {
      // TODO: Verify exact asset name from latest GitHub Release at implementation time
      return 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-cli-darwin-arm64'
    }
    throw new Error(`Unsupported platform: ${platform} ${arch}`)
  }

  private getFfmpegDownloadUrl(): string {
    const platform = process.platform
    if (platform === 'darwin') {
      return 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
    }
    throw new Error(`Unsupported platform: ${platform}`)
  }

  private async downloadFile(url: string, destPath: string, label: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`)
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0)
    let downloadedBytes = 0

    const fileStream = createWriteStream(destPath)
    const reader = response.body?.getReader()
    if (!reader) throw new Error(`No response body for ${label}`)

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fileStream.write(value)
        downloadedBytes += value.length
        this.emit('download-progress', {
          file: label,
          percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
          bytesDownloaded: downloadedBytes,
          bytesTotal: totalBytes,
        } as DownloadProgress)
      }
    } finally {
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/whisper-manager.ts src/main/services/__tests__/whisper-manager.test.ts
git commit -m "feat(transcription): add WhisperManager with retry logic and binary management"
```

---

### Task 3: AudioConverter

**Files:**
- Create: `src/main/services/audio-converter.ts`
- Test: `src/main/services/__tests__/audio-converter.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/main/services/__tests__/audio-converter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AudioConverter } from '../audio-converter'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

const mockSpawn = vi.mocked(await import('child_process')).spawn

function createMockProcess(exitCode: number, stderr = '') {
  const proc = {
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(exitCode), 0)
      }
      return proc
    }),
    stderr: {
      on: vi.fn((event: string, cb: Function) => {
        if (event === 'data' && stderr) {
          setTimeout(() => cb(Buffer.from(stderr)), 0)
        }
        return proc.stderr
      }),
    },
  }
  return proc
}

describe('AudioConverter', () => {
  let converter: AudioConverter

  beforeEach(() => {
    vi.clearAllMocks()
    converter = new AudioConverter()
  })

  it('spawns ffmpeg with correct arguments', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0) as any)

    await converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')

    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/ffmpeg',
      ['-i', '/input/audio.webm', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', '/output/audio.wav'],
    )
  })

  it('resolves on exit code 0', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0) as any)

    await expect(
      converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')
    ).resolves.toBeUndefined()
  })

  it('rejects on non-zero exit code', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, 'Invalid input') as any)

    await expect(
      converter.convert('/input/audio.webm', '/output/audio.wav', '/bin/ffmpeg')
    ).rejects.toThrow('ffmpeg exited with code 1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: FAIL — `audio-converter` module not found

- [ ] **Step 3: Implement AudioConverter**

Create `src/main/services/audio-converter.ts`:

```typescript
import { spawn } from 'child_process'

export class AudioConverter {
  convert(inputPath: string, outputPath: string, ffmpegPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''

      const proc = spawn(ffmpegPath, [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-y',
        outputPath,
      ])

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/audio-converter.ts src/main/services/__tests__/audio-converter.test.ts
git commit -m "feat(transcription): add AudioConverter for WebM to WAV conversion"
```

---

### Task 4: TranscriptionService

**Files:**
- Create: `src/main/services/transcription.ts`
- Test: `src/main/services/__tests__/transcription.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/main/services/__tests__/transcription.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TranscriptionService } from '../transcription'
import type { WhisperManager } from '../whisper-manager'
import type { AudioConverter } from '../audio-converter'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

const fsMock = vi.mocked(await import('fs/promises'))

function createMockWhisperManager(ready = true): WhisperManager {
  return {
    isReady: vi.fn().mockResolvedValue(ready),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getWhisperPath: vi.fn().mockReturnValue('/mock/whisper'),
    getFfmpegPath: vi.fn().mockReturnValue('/mock/ffmpeg'),
    getModelPath: vi.fn().mockReturnValue('/mock/model.bin'),
    getModelsDir: vi.fn().mockReturnValue('/mock/home/AutoDoc/models'),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as WhisperManager
}

function createMockAudioConverter(): AudioConverter {
  return {
    convert: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioConverter
}

describe('TranscriptionService', () => {
  let service: TranscriptionService
  let mockWhisper: WhisperManager
  let mockConverter: AudioConverter

  beforeEach(() => {
    vi.clearAllMocks()
    mockWhisper = createMockWhisperManager()
    mockConverter = createMockAudioConverter()
    service = new TranscriptionService(
      mockWhisper,
      mockConverter,
      '/mock/home/AutoDoc/recordings'
    )
  })

  it('returns pending status for unknown meetingId when no files exist', async () => {
    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    const status = await service.getStatus('unknown-id')
    expect(status).toBe('pending')
  })

  it('returns complete status when transcript.json exists', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.json')) return undefined
      throw new Error('ENOENT')
    })
    const status = await service.getStatus('completed-meeting')
    expect(status).toBe('complete')
  })

  it('returns failed status when transcript.error exists', async () => {
    fsMock.access.mockImplementation(async (path) => {
      if (String(path).endsWith('transcript.error')) return undefined
      throw new Error('ENOENT')
    })
    const status = await service.getStatus('failed-meeting')
    expect(status).toBe('failed')
  })

  it('returns queued status after enqueue', async () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)
    service.enqueue('meeting-123')

    fsMock.access.mockRejectedValue(new Error('ENOENT'))
    const status = await service.getStatus('meeting-123')
    expect(status).toBe('queued')
  })

  it('is idempotent - enqueuing same meetingId twice does not duplicate', () => {
    vi.spyOn(service as any, 'processNext').mockResolvedValue(undefined)

    service.enqueue('meeting-123')
    service.enqueue('meeting-123')

    const queue = (service as any).queue as string[]
    expect(queue.filter((id: string) => id === 'meeting-123')).toHaveLength(1)
  })

  it('getTranscript returns parsed transcript.json', async () => {
    const transcriptData = [
      { id: 'meeting-1-0', meetingId: 'meeting-1', speaker: 'Speaker', text: 'Hello', startMs: 0, endMs: 1000, confidence: -1 }
    ]
    fsMock.readFile.mockResolvedValue(JSON.stringify(transcriptData) as any)

    const result = await service.getTranscript('meeting-1')
    expect(result).toEqual(transcriptData)
  })

  it('getTranscript returns empty array when file missing', async () => {
    fsMock.readFile.mockRejectedValue(new Error('ENOENT'))

    const result = await service.getTranscript('missing-meeting')
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: FAIL — `transcription` module not found

- [ ] **Step 3: Implement TranscriptionService**

Create `src/main/services/transcription.ts`:

```typescript
import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import type { Transcript, TranscriptionStatus } from '../../shared/types'
import type { WhisperManager } from './whisper-manager'
import type { AudioConverter } from './audio-converter'

interface WhisperSegment {
  t0: number
  t1: number
  text: string
}

interface WhisperOutput {
  segments: WhisperSegment[]
}

export class TranscriptionService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: TranscriptionStatus | null = null
  private processing = false

  constructor(
    private whisperManager: WhisperManager,
    private audioConverter: AudioConverter,
    private recordingsBaseDir: string,
  ) {}

  enqueue(meetingId: string): void {
    if (this.activeJobId === meetingId) return
    if (this.queue.includes(meetingId)) return
    this.queue.push(meetingId)
    this.broadcastStatus(meetingId, 'queued')
    this.processNext()
  }

  retry(meetingId: string): void {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    unlink(errorPath).catch(() => {})
    this.enqueue(meetingId)
  }

  async getStatus(meetingId: string): Promise<TranscriptionStatus> {
    // Check in-memory state first
    if (this.activeJobId === meetingId && this.activeStatus) {
      return this.activeStatus
    }
    if (this.queue.includes(meetingId)) {
      return 'queued'
    }
    // Check filesystem
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    if (await this.fileExists(join(meetingDir, 'transcript.json'))) return 'complete'
    if (await this.fileExists(join(meetingDir, 'transcript.error'))) return 'failed'
    return 'pending'
  }

  async getTranscript(meetingId: string): Promise<Transcript[]> {
    const transcriptPath = join(this.recordingsBaseDir, meetingId, 'transcript.json')
    try {
      const data = await readFile(transcriptPath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return []
    }
  }

  async scanAndEnqueuePending(): Promise<void> {
    const { readdir, stat } = await import('fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.recordingsBaseDir)
    } catch {
      return
    }

    for (const meetingId of dirs) {
      const meetingDir = join(this.recordingsBaseDir, meetingId)
      const dirStat = await stat(meetingDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const audioPath = join(meetingDir, 'audio.webm')
      const transcriptPath = join(meetingDir, 'transcript.json')
      const errorPath = join(meetingDir, 'transcript.error')

      const hasAudio = await this.fileExists(audioPath)
      const hasTranscript = await this.fileExists(transcriptPath)
      const hasError = await this.fileExists(errorPath)

      if (hasAudio && !hasTranscript && !hasError) {
        this.enqueue(meetingId)
      }
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) return
    if (this.queue.length === 0) return

    this.processing = true
    const meetingId = this.queue.shift()!
    this.activeJobId = meetingId

    try {
      await this.processJob(meetingId)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await this.markFailed(meetingId, errorMsg)
    } finally {
      this.activeJobId = null
      this.activeStatus = null
      this.processing = false
      this.processNext()
    }
  }

  private async processJob(meetingId: string): Promise<void> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const audioWebm = join(meetingDir, 'audio.webm')
    const audioWav = join(meetingDir, 'audio.wav')
    const whisperJsonOutput = join(meetingDir, 'audio.wav.json')
    const transcriptPath = join(meetingDir, 'transcript.json')

    // Check audio exists — skip video-only recordings silently
    if (!(await this.fileExists(audioWebm))) {
      return
    }

    // Ensure whisper.cpp and dependencies are ready
    if (!(await this.whisperManager.isReady())) {
      this.activeStatus = 'downloading'
      this.broadcastStatus(meetingId, 'downloading')
      await this.whisperManager.ensureReady()
    }

    // Convert WebM to WAV
    this.activeStatus = 'transcribing'
    this.broadcastStatus(meetingId, 'transcribing')

    await this.audioConverter.convert(
      audioWebm,
      audioWav,
      this.whisperManager.getFfmpegPath()
    )

    // Run whisper.cpp
    await this.runWhisper(audioWav)

    // Parse output
    const whisperJson = await readFile(whisperJsonOutput, 'utf-8')
    const whisperOutput: WhisperOutput = JSON.parse(whisperJson)
    const transcripts = this.mapToTranscripts(meetingId, whisperOutput)

    // Write transcript.json
    await writeFile(transcriptPath, JSON.stringify(transcripts, null, 2))

    // Cleanup intermediate files
    await unlink(audioWav).catch(() => {})
    await unlink(whisperJsonOutput).catch(() => {})

    this.activeStatus = 'complete'
    this.broadcastStatus(meetingId, 'complete')
  }

  private runWhisper(audioWavPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = 30 * 60 * 1000 // 30 minutes
      let stderr = ''

      const proc = spawn(this.whisperManager.getWhisperPath(), [
        '-m', this.whisperManager.getModelPath(),
        '-f', audioWavPath,
        '-oj', // JSON output
        '-l', 'en',
      ])

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('whisper.cpp timed out after 30 minutes'))
      }, timeout)

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }

  private mapToTranscripts(meetingId: string, output: WhisperOutput): Transcript[] {
    return output.segments.map((seg, index) => ({
      id: `${meetingId}-${index}`,
      meetingId,
      speaker: 'Speaker',
      text: seg.text.trim(),
      startMs: seg.t0 * 10,
      endMs: seg.t1 * 10,
      confidence: -1,
    }))
  }

  private async markFailed(meetingId: string, error: string): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    await writeFile(errorPath, error)
    this.broadcastStatus(meetingId, 'failed')
  }

  private broadcastStatus(meetingId: string, status: TranscriptionStatus): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('transcription:status-changed', { meetingId, status })
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.main.config.mts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/transcription.ts src/main/services/__tests__/transcription.test.ts
git commit -m "feat(transcription): add TranscriptionService with job queue and whisper.cpp integration"
```

---

### Task 5: Transcription IPC and Wiring

**Files:**
- Create: `src/main/ipc/transcription-ipc.ts`
- Modify: `src/main/ipc/recording-ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create transcription IPC handler file**

Create `src/main/ipc/transcription-ipc.ts`:

```typescript
import { ipcMain } from 'electron'
import type { TranscriptionService } from '../services/transcription'
import type { Transcript, TranscriptionStatus } from '../../shared/types'

export function registerTranscriptionIpc(transcriptionService: TranscriptionService): void {
  ipcMain.handle(
    'transcription:get-status',
    async (_event, meetingId: string): Promise<TranscriptionStatus> => {
      return transcriptionService.getStatus(meetingId)
    }
  )

  ipcMain.handle(
    'transcription:get-transcript',
    async (_event, meetingId: string): Promise<Transcript[]> => {
      return transcriptionService.getTranscript(meetingId)
    }
  )

  ipcMain.handle(
    'transcription:retry',
    async (_event, meetingId: string): Promise<void> => {
      transcriptionService.retry(meetingId)
    }
  )
}
```

- [ ] **Step 2: Modify recording-ipc.ts to accept TranscriptionService**

In `src/main/ipc/recording-ipc.ts`:

Update the import to add `TranscriptionService`:

```typescript
import { TranscriptionService } from '../services/transcription'
```

Change function signature:

```typescript
export function registerRecordingIpc(
  recordingService: RecordingService,
  transcriptionService: TranscriptionService,
): void {
```

Modify `recording:stop` handler to enqueue transcription:

```typescript
  ipcMain.handle('recording:stop', () => {
    const result = recordingService.stopRecording()
    broadcastState(recordingService.getState())
    transcriptionService.enqueue(result.meetingId)
    return result
  })
```

Update the `recording:list` handler to include `transcriptionStatus` in each entry. Add this line inside the for loop, after computing `hasAudio`/`hasVideo`:

```typescript
      const transcriptionStatus = await transcriptionService.getStatus(meetingId)
```

And update the `entries.push` call to include it:

```typescript
      entries.push({
        meetingId,
        title: `Recording ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        date: createdAt.getTime(),
        duration: null,
        hasVideo: videoStat !== null,
        hasAudio: audioStat !== null,
        transcriptionStatus,
      })
```

- [ ] **Step 3: Wire up in main/index.ts**

In `src/main/index.ts`, add imports:

```typescript
import { WhisperManager } from './services/whisper-manager'
import { AudioConverter } from './services/audio-converter'
import { TranscriptionService } from './services/transcription'
import { registerTranscriptionIpc } from './ipc/transcription-ipc'
```

After `const recordingService = new RecordingService()` (line 74), add:

```typescript
  const whisperManager = new WhisperManager()
  const audioConverter = new AudioConverter()
  const transcriptionService = new TranscriptionService(
    whisperManager,
    audioConverter,
    recordingService.getRecordingsBaseDir(),
  )
```

Update `registerRecordingIpc` call:

```typescript
  registerRecordingIpc(recordingService, transcriptionService)
  registerTranscriptionIpc(transcriptionService)
```

After `createWindow()`, add:

```typescript
  transcriptionService.scanAndEnqueuePending()
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `npx vitest run --config vitest.main.config.mts && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/transcription-ipc.ts src/main/ipc/recording-ipc.ts src/main/index.ts
git commit -m "feat(transcription): wire up IPC handlers and auto-enqueue on recording stop"
```

---

### Task 6: TranscriptionBadge Component

**Files:**
- Create: `src/renderer/src/components/TranscriptionBadge.tsx`
- Test: `src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx`

- [ ] **Step 1: Write the tests**

Create `src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TranscriptionBadge } from '../TranscriptionBadge'

describe('TranscriptionBadge', () => {
  it('shows "Awaiting transcription" for pending status', () => {
    render(<TranscriptionBadge status="pending" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows "Awaiting transcription" for queued status', () => {
    render(<TranscriptionBadge status="queued" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows "Downloading model..." for downloading status', () => {
    render(<TranscriptionBadge status="downloading" />)
    expect(screen.getByText('Downloading model...')).toBeInTheDocument()
  })

  it('shows "Transcribing..." for transcribing status', () => {
    render(<TranscriptionBadge status="transcribing" />)
    expect(screen.getByText('Transcribing...')).toBeInTheDocument()
  })

  it('shows "Transcribed" for complete status', () => {
    render(<TranscriptionBadge status="complete" />)
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
  })

  it('shows "Failed — Retry" for failed status', () => {
    render(<TranscriptionBadge status="failed" />)
    expect(screen.getByText('Failed — Retry')).toBeInTheDocument()
  })

  it('calls onRetry when failed badge is clicked', () => {
    const onRetry = vi.fn()
    render(<TranscriptionBadge status="failed" onRetry={onRetry} />)
    fireEvent.click(screen.getByText('Failed — Retry'))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `TranscriptionBadge` module not found

- [ ] **Step 3: Implement TranscriptionBadge**

Create `src/renderer/src/components/TranscriptionBadge.tsx`:

```tsx
import type { TranscriptionStatus } from '../../../shared/types'

const STATUS_CONFIG: Record<TranscriptionStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent',
  },
  queued: {
    label: 'Awaiting transcription',
    className: 'text-ink-faint bg-bg-accent',
  },
  downloading: {
    label: 'Downloading model...',
    className: 'text-ink-muted bg-bg-accent animate-pulse',
  },
  transcribing: {
    label: 'Transcribing...',
    className: 'text-ink-muted bg-bg-accent animate-pulse',
  },
  complete: {
    label: 'Transcribed',
    className: 'text-green-700 bg-green-50',
  },
  failed: {
    label: 'Failed — Retry',
    className: 'text-red-700 bg-red-50 cursor-pointer hover:bg-red-100',
  },
}

interface TranscriptionBadgeProps {
  status: TranscriptionStatus
  onRetry?: () => void
}

export function TranscriptionBadge({ status, onRetry }: TranscriptionBadgeProps) {
  const config = STATUS_CONFIG[status]

  return (
    <span
      className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${config.className}`}
      onClick={status === 'failed' ? onRetry : undefined}
    >
      {config.label}
    </span>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TranscriptionBadge.tsx src/renderer/src/components/__tests__/TranscriptionBadge.test.tsx
git commit -m "feat(transcription): add TranscriptionBadge component"
```

---

### Task 7: Update Recordings Page with Live Status

**Files:**
- Modify: `src/renderer/src/pages/Recordings.tsx`

- [ ] **Step 1: Rewrite Recordings page to use transcriptionStatus and live updates**

Replace the full content of `src/renderer/src/pages/Recordings.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { TranscriptionBadge } from '../components/TranscriptionBadge'
import type { RecordingEntry } from '../../../shared/types'

export function Recordings() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    window.electronAPI
      .invoke('recording:list')
      .then((entries) => {
        setRecordings(entries)
      })
      .catch((err) => {
        console.error('Failed to list recordings:', err)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.on(
      'transcription:status-changed',
      (payload) => {
        setRecordings((prev) =>
          prev.map((rec) =>
            rec.meetingId === payload.meetingId
              ? { ...rec, transcriptionStatus: payload.status }
              : rec
          )
        )
      }
    )
    return unsubscribe
  }, [])

  const handleRetry = (meetingId: string) => {
    window.electronAPI.invoke('transcription:retry', meetingId)
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Recordings" />

      {loading ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">Loading...</p>
        </div>
      ) : recordings.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <p className="text-ink-muted text-[13px]">
            No recordings yet. Start a meeting to begin.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-2">
            {recordings.map((rec) => (
              <div
                key={rec.meetingId}
                className="px-4 py-3.5 bg-bg-card border border-border rounded-xl cursor-pointer hover:border-ink-muted transition-colors"
                onClick={() => navigate(`/recordings/${rec.meetingId}`)}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <div className="text-[13.5px] font-semibold text-ink tracking-[-0.01em]">
                      {rec.title}
                    </div>
                    <div className="text-[11.5px] text-ink-faint mt-0.5 flex items-center gap-2">
                      <span>
                        {new Date(rec.date).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <span className="text-border">|</span>
                      <span className="flex items-center gap-1">
                        {rec.hasAudio && <span>Audio</span>}
                        {rec.hasAudio && rec.hasVideo && <span>+</span>}
                        {rec.hasVideo && <span>Video</span>}
                      </span>
                    </div>
                  </div>
                  <TranscriptionBadge
                    status={rec.transcriptionStatus}
                    onRetry={() => handleRetry(rec.meetingId)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: No type errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/Recordings.tsx
git commit -m "feat(transcription): update Recordings page with live transcription status"
```

---

### Task 8: TranscriptView Component

**Files:**
- Create: `src/renderer/src/components/TranscriptView.tsx`
- Test: `src/renderer/src/components/__tests__/TranscriptView.test.tsx`

- [ ] **Step 1: Write the tests**

Create `src/renderer/src/components/__tests__/TranscriptView.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TranscriptView } from '../TranscriptView'
import type { Transcript } from '../../../../shared/types'

const sampleTranscripts: Transcript[] = [
  { id: 'seg-0', meetingId: 'm1', speaker: 'Speaker', text: 'Hello everyone', startMs: 0, endMs: 3000, confidence: -1 },
  { id: 'seg-1', meetingId: 'm1', speaker: 'Speaker', text: 'Let us begin the meeting', startMs: 3000, endMs: 7500, confidence: -1 },
]

describe('TranscriptView', () => {
  it('renders transcript segments with timestamps', () => {
    render(<TranscriptView segments={sampleTranscripts} status="complete" />)
    expect(screen.getByText('Hello everyone')).toBeInTheDocument()
    expect(screen.getByText('Let us begin the meeting')).toBeInTheDocument()
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('0:03')).toBeInTheDocument()
  })

  it('shows transcribing message when status is transcribing', () => {
    render(<TranscriptView segments={[]} status="transcribing" />)
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument()
  })

  it('shows downloading message when status is downloading', () => {
    render(<TranscriptView segments={[]} status="downloading" />)
    expect(screen.getByText(/downloading/i)).toBeInTheDocument()
  })

  it('shows pending message when status is pending', () => {
    render(<TranscriptView segments={[]} status="pending" />)
    expect(screen.getByText(/awaiting/i)).toBeInTheDocument()
  })

  it('shows empty state when complete with no segments', () => {
    render(<TranscriptView segments={[]} status="complete" />)
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `TranscriptView` module not found

- [ ] **Step 3: Implement TranscriptView**

Create `src/renderer/src/components/TranscriptView.tsx`:

```tsx
import type { Transcript, TranscriptionStatus } from '../../../shared/types'

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

interface TranscriptViewProps {
  segments: Transcript[]
  status: TranscriptionStatus
}

export function TranscriptView({ segments, status }: TranscriptViewProps) {
  if (status === 'pending' || status === 'queued') {
    return (
      <p className="text-[12px] text-ink-muted">
        Awaiting transcription. This will begin automatically.
      </p>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Downloading transcription model...
        </p>
      </div>
    )
  }

  if (status === 'transcribing') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <p className="text-[12px] text-ink-muted">
          Transcribing audio...
        </p>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <p className="text-[12px] text-red-600">
        Transcription failed. Use the retry button to try again.
      </p>
    )
  }

  // status === 'complete'
  if (segments.length === 0) {
    return (
      <p className="text-[12px] text-ink-muted">
        No transcript segments found.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {segments.map((seg) => (
        <div key={seg.id} className="flex gap-3">
          <span className="text-[11px] text-ink-faint font-mono w-10 shrink-0 pt-0.5">
            {formatTimestamp(seg.startMs)}
          </span>
          <p className="text-[12.5px] text-ink leading-relaxed">
            {seg.text}
          </p>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TranscriptView.tsx src/renderer/src/components/__tests__/TranscriptView.test.tsx
git commit -m "feat(transcription): add TranscriptView component for displaying transcript segments"
```

---

### Task 9: Update Meeting Detail Page

**Files:**
- Modify: `src/renderer/src/pages/MeetingDetail.tsx`

- [ ] **Step 1: Rewrite MeetingDetail to fetch and display transcript**

Replace the full content of `src/renderer/src/pages/MeetingDetail.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { SEGMENT_LABELS } from '../../../shared/constants'
import type { SegmentCategory, Transcript, TranscriptionStatus } from '../../../shared/types'
import { TranscriptView } from '../components/TranscriptView'
import { TranscriptionBadge } from '../components/TranscriptionBadge'

type Tab = 'notes' | 'transcript'

const CATEGORY_ORDER: SegmentCategory[] = [
  'decision',
  'action_item',
  'information',
  'discussion',
  'status_update',
]

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState<Tab>('notes')
  const [transcript, setTranscript] = useState<Transcript[]>([])
  const [status, setStatus] = useState<TranscriptionStatus>('pending')

  useEffect(() => {
    if (!id) return

    window.electronAPI.invoke('transcription:get-status', id).then(setStatus)
    window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)

    const unsubscribe = window.electronAPI.on(
      'transcription:status-changed',
      (payload) => {
        if (payload.meetingId === id) {
          setStatus(payload.status)
          if (payload.status === 'complete') {
            window.electronAPI.invoke('transcription:get-transcript', id).then(setTranscript)
          }
        }
      }
    )
    return unsubscribe
  }, [id])

  const handleRetry = () => {
    if (id) {
      window.electronAPI.invoke('transcription:retry', id)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-bold text-ink tracking-[-0.02em]">
            Meeting
          </h1>
          <p className="text-[11px] text-ink-faint mt-0.5">ID: {id}</p>
        </div>
        <TranscriptionBadge status={status} onRetry={handleRetry} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        {(['notes', 'transcript'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3.5 py-2.5 text-[11.5px] font-semibold transition-colors ${
              activeTab === tab
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab === 'notes' ? 'Notes' : 'Transcript'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'notes' ? (
          <div className="flex flex-col gap-4">
            {CATEGORY_ORDER.map((category) => (
              <div
                key={category}
                className="bg-bg-card border border-border rounded-xl p-4"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-ink" />
                  <span className="text-[11px] font-bold text-ink tracking-[0.03em] uppercase">
                    {SEGMENT_LABELS[category]}
                  </span>
                </div>
                <p className="text-[12px] text-ink-muted leading-relaxed">
                  No {SEGMENT_LABELS[category].toLowerCase()} recorded yet.
                </p>
              </div>
            ))}
          </div>
        ) : (
          <TranscriptView segments={transcript} status={status} />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: No type errors, all tests pass. If `MeetingDetail.test.tsx` fails due to changed content, update it to match (the test checks for basic rendering which should still pass).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages/MeetingDetail.tsx
git commit -m "feat(transcription): update MeetingDetail page with live transcript display"
```

---

### Task 10: Build and Verify

**Files:** None (verification only)

- [ ] **Step 1: Build the app**

Run: `npx electron-vite build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run && npx vitest run --config vitest.main.config.mts`
Expected: All tests pass

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Start dev server and verify**

Run: `npx electron-vite dev`

Manual verification checklist:
- Recordings page loads and shows existing recordings with transcription status badges
- Recording cards are clickable and navigate to meeting detail page
- Meeting detail page shows Transcript tab with status-appropriate content
- Starting and stopping a recording triggers transcription auto-enqueue
- Badge shows "Downloading model..." on first run (download URLs may need adjustment — see whisper.cpp TODO in WhisperManager)

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "fix(transcription): address issues found during manual testing"
```
