import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { availableParallelism, constants as osConstants, cpus, setPriority, tmpdir } from 'os'
import { spawn } from 'child_process'
import type { Transcript, TranscriptionStatus, SpeakerMap, TranscriptionStatusPayload } from '../../shared/types'
import type { WhisperManager } from './whisper-manager'
import type { AudioConverter } from './audio-converter'
import { alignSpeakers } from './speaker-alignment'
import { matchCalendarEvent, readMetadata } from './calendar-matcher'
import { encryptJSON, decryptJSON, decryptFileToTemp, isEncrypted, encryptFileInPlace } from './crypto'
import { logAutodocFailure } from './autodoc-log'
import type { CalendarManager } from './calendar-manager'
import { classifyError } from './error-classification'

interface WhisperSegment {
  offsets: { from: number; to: number }
  text: string
}

interface WhisperOutput {
  transcription: WhisperSegment[]
}

const MIN_WHISPER_THREADS = 4
const MAX_WHISPER_THREADS = 10
const RESERVED_LOGICAL_CPUS = 6
const CHUNKED_TRANSCRIPTION_THRESHOLD_SEC = 180
const CHUNKED_TRANSCRIPTION_WINDOW_SEC = 90
const CHUNKED_TRANSCRIPTION_OVERLAP_SEC = 5
const CHUNKED_TRANSCRIPTION_MAX_SEGMENT_CHARS = 50
const REPETITION_WINDOW_SEGMENTS = 24
const REPETITION_WINDOW_MAX_UNIQUE = 4
const REPETITION_WINDOW_MIN_RATIO = 0.8
type EnqueueSource = 'direct' | 'recovery-scan'

interface TranscriptionDirSnapshot extends Record<string, unknown> {
  source: EnqueueSource | 'unknown'
  files: {
    micExists: boolean
    micEncrypted: boolean
    systemExists: boolean
    systemEncrypted: boolean
    legacyExists: boolean
    legacyEncrypted: boolean
    screenExists: boolean
    transcriptExists: boolean
    segmentsExists: boolean
    errorExists: boolean
    metadataExists: boolean
  }
  retryCount: number
}

export class TranscriptionService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: TranscriptionStatus | null = null
  private activeProgress: number | undefined = undefined
  private processing = false
  private onCompleteCallback: ((meetingId: string) => void) | null = null
  private enqueueSource = new Map<string, EnqueueSource>()

  constructor(
    private whisperManager: WhisperManager,
    private audioConverter: AudioConverter,
    private recordingsBaseDir: string,
    private calendarManager: CalendarManager,
    private isMeetingActive: (meetingId: string) => boolean = () => false,
  ) {}

  onComplete(callback: (meetingId: string) => void): void {
    this.onCompleteCallback = callback
  }

  enqueue(meetingId: string, source: EnqueueSource = 'direct'): void {
    if (this.activeJobId === meetingId) return
    if (this.queue.includes(meetingId)) return
    this.enqueueSource.set(meetingId, source)
    this.queue.push(meetingId)
    this.broadcastStatus(meetingId, 'queued')
    this.processNext()
  }

  retry(meetingId: string, source: EnqueueSource = 'direct'): void {
    this.enqueue(meetingId, source)
  }

  getProgress(meetingId: string): number | undefined {
    if (this.activeJobId === meetingId) return this.activeProgress
    return undefined
  }

  async getStatus(meetingId: string): Promise<TranscriptionStatus> {
    if (this.activeJobId === meetingId && this.activeStatus) {
      return this.activeStatus
    }
    if (this.queue.includes(meetingId)) {
      return 'queued'
    }
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')
    const errorPath = join(meetingDir, 'transcript.error')
    const hasTranscript = await this.fileExists(transcriptPath)
    const hasError = await this.fileExists(errorPath)

    if (hasTranscript && hasError) {
      const [transcriptStat, errorStat] = await Promise.all([
        stat(transcriptPath).catch(() => null),
        stat(errorPath).catch(() => null),
      ])
      if (transcriptStat && errorStat && errorStat.mtimeMs > transcriptStat.mtimeMs) {
        return 'failed'
      }
    }

    if (hasTranscript) return 'complete'
    if (hasError) return 'failed'
    return 'pending'
  }

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

  async scanAndEnqueuePending(): Promise<void> {
    const { readdir, stat } = await import('fs/promises')
    let dirs: string[]
    try {
      dirs = await readdir(this.recordingsBaseDir)
    } catch {
      return
    }

    for (const meetingId of dirs) {
      try {
        if (this.isMeetingActive(meetingId)) continue

        const meetingDir = join(this.recordingsBaseDir, meetingId)
        const dirStat = await stat(meetingDir).catch(() => null)
        if (!dirStat?.isDirectory()) continue

        const audioPath = join(meetingDir, 'audio.webm')
        const micPath = join(meetingDir, 'mic.webm')
        const transcriptPath = join(meetingDir, 'transcript.json')
        const errorPath = join(meetingDir, 'transcript.error')

        const hasAudio = await this.fileExists(audioPath) || await this.fileExists(micPath)
        const hasTranscript = await this.fileExists(transcriptPath)
        const hasError = await this.fileExists(errorPath)

        if (hasAudio && !hasTranscript && !hasError) {
          this.enqueue(meetingId, 'recovery-scan')
        } else if (hasAudio && !hasTranscript && hasError) {
          const errorData = await this.readErrorFile(errorPath)
          const errorCode = errorData ? classifyError(errorData.error) : 'unknown'
          const isPermanentFailure = errorCode === 'key-mismatch' || errorCode === 'encryption-key-unavailable'
          if (errorData && errorData.retries < 3 && !isPermanentFailure) {
            console.log(`Auto-retrying transcription for ${meetingId} (attempt ${errorData.retries + 1}/3)`)
            this.retry(meetingId, 'recovery-scan')
          }
        }
      } catch (err) {
        console.warn(`Failed to inspect transcription state for ${meetingId}:`, err)
        logAutodocFailure({
          area: 'transcription',
          message: 'Failed to inspect transcription state during pending scan',
          error: err,
          meetingId,
        })
      }
    }
  }

  private async processNext(): Promise<void> {
    if (this.processing) return
    if (this.queue.length === 0) return

    this.processing = true
    const meetingId = this.queue.shift()!
    this.activeJobId = meetingId
    const dirSnapshot = await this.captureDirSnapshot(meetingId).catch(() => undefined)

    try {
      await this.processJob(meetingId)
    } catch (err) {
      await this.markFailed(meetingId, err instanceof Error ? err : String(err), dirSnapshot)
    } finally {
      this.activeJobId = null
      this.activeStatus = null
      this.activeProgress = undefined
      this.processing = false
      this.enqueueSource.delete(meetingId)
      this.processNext()
    }
  }

  private async processJob(meetingId: string): Promise<void> {
    if (this.isMeetingActive(meetingId)) {
      console.log(`Skipping transcription for active recording: ${meetingId}`)
      return
    }

    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')

    const micWebm = join(meetingDir, 'mic.webm')
    const systemWebm = join(meetingDir, 'system.webm')
    const legacyAudio = join(meetingDir, 'audio.webm')

    const hasMic = await this.fileExists(micWebm)
    const hasSystem = await this.fileExists(systemWebm)
    const hasLegacy = await this.fileExists(legacyAudio)

    if (!hasMic && !hasLegacy) {
      return
    }

    const tempPrefix = join(tmpdir(), `autodoc-${meetingId}-${Date.now()}`)
    const tempAudioWav = `${tempPrefix}.wav`
    const tempFiles: string[] = [tempAudioWav]

    try {
      const benchmarkStart = Date.now()

      if (!(await this.whisperManager.isReady())) {
        this.activeStatus = 'downloading'
        this.broadcastStatus(meetingId, 'downloading')
        await this.whisperManager.ensureReady()
      }

      this.activeStatus = 'transcribing'
      this.broadcastStatus(meetingId, 'transcribing')

      // Prepare audio input for whisper
      let t0 = Date.now()
      const audioInput = await this.prepareWhisperInput(
        micWebm, systemWebm, legacyAudio,
        hasMic, hasSystem, hasLegacy,
        tempPrefix, tempFiles,
      )

      await this.audioConverter.convert(audioInput, tempAudioWav, this.whisperManager.getFfmpegPath())

      const audioDuration = await this.audioConverter.getDuration(
        tempAudioWav,
        this.whisperManager.getFfmpegPath()
      ).catch(() => undefined)
      console.log(`[perf] Audio conversion: ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId})`)

      t0 = Date.now()
      const whisperOutput = await this.transcribeWithFallback(
        tempAudioWav,
        meetingId,
        audioDuration,
        tempPrefix,
        tempFiles,
      )
      console.log(`[perf] Transcription (whisper): ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId})`)
      let transcripts = this.mapToTranscripts(meetingId, whisperOutput)

      // Speaker labeling (two-stream: system active = remote, system silent = "me")
      // Use system.webm if available; fall back to extracting audio from screen.webm
      const screenWebm = join(meetingDir, 'screen.webm')
      const hasScreen = await this.fileExists(screenWebm)
      const canDiarize = hasMic && (hasSystem || hasScreen)

      if (canDiarize) {
        try {
          t0 = Date.now()
          this.activeStatus = 'diarizing'
          this.broadcastStatus(meetingId, 'diarizing')

          const tempSystemWav = `${tempPrefix}-system.wav`
          tempFiles.push(tempSystemWav)

          if (hasSystem) {
            // Preferred: use the dedicated system audio stream
            const systemInput = await this.decryptIfNeeded(systemWebm, tempFiles)
            await this.audioConverter.convert(systemInput, tempSystemWav, this.whisperManager.getFfmpegPath())
          } else {
            // Fallback: extract audio from screen.webm (system audio is muxed in)
            console.log(`[diarize] system.webm missing, extracting audio from screen.webm (${meetingId})`)
            const screenInput = await this.decryptIfNeeded(screenWebm, tempFiles)
            await this.audioConverter.convert(screenInput, tempSystemWav, this.whisperManager.getFfmpegPath())
          }

          const systemSegments = await this.detectAudioActivity(tempSystemWav)
          transcripts = alignSpeakers(transcripts, null, systemSegments)
          await this.generateSpeakersJson(meetingId, transcripts)
          console.log(`[perf] Speaker labeling: ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId})`)
        } catch (err) {
          logAutodocFailure({
            area: 'transcription',
            message: 'Speaker labeling failed during transcription',
            error: err,
            meetingId,
          })
          console.error('Speaker labeling failed:', err)
        }
      }

      await encryptJSON(transcripts, transcriptPath)
      await unlink(join(meetingDir, 'transcript.error')).catch(() => {})

      // Encrypt raw media files
      for (const filename of ['mic.webm', 'system.webm', 'screen.webm']) {
        const filePath = join(meetingDir, filename)
        try {
          if ((await this.fileExists(filePath)) && !(await isEncrypted(filePath))) {
            await encryptFileInPlace(filePath)
          }
        } catch (err) {
          logAutodocFailure({
            area: 'transcription',
            message: `Failed to encrypt ${filename} after transcription`,
            error: err,
            meetingId,
          })
          console.error(`Failed to encrypt ${filePath}:`, err)
        }
      }

      console.log(`[perf] Transcription total: ${((Date.now() - benchmarkStart) / 1000).toFixed(1)}s (${meetingId})`)

      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete')
      this.onCompleteCallback?.(meetingId)
    } finally {
      for (const f of tempFiles) {
        await unlink(f).catch(() => {})
      }
    }
  }

  private async decryptIfNeeded(filePath: string, tempFiles: string[]): Promise<string> {
    if (await isEncrypted(filePath)) {
      const temp = await decryptFileToTemp(filePath)
      tempFiles.push(temp)
      return temp
    }
    return filePath
  }

  private async prepareWhisperInput(
    micWebm: string, systemWebm: string, legacyAudio: string,
    hasMic: boolean, hasSystem: boolean, _hasLegacy: boolean,
    tempPrefix: string, tempFiles: string[],
  ): Promise<string> {
    if (hasMic) {
      const micInput = await this.decryptIfNeeded(micWebm, tempFiles)
      if (hasSystem) {
        const systemInput = await this.decryptIfNeeded(systemWebm, tempFiles)
        const mergedPath = `${tempPrefix}-merged.webm`
        tempFiles.push(mergedPath)
        await this.audioConverter.mergeAudio(micInput, systemInput, mergedPath, this.whisperManager.getFfmpegPath())
        return mergedPath
      }
      return micInput
    }
    // Legacy single-file format
    return await this.decryptIfNeeded(legacyAudio, tempFiles)
  }

  private detectAudioActivity(wavPath: string): Promise<{ start: number; end: number }[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.whisperManager.getFfmpegPath(), [
        '-i', wavPath,
        '-af', 'silencedetect=noise=-30dB:d=0.5',
        '-f', 'null', '-',
      ])
      let stderr = ''
      proc.on('error', (err) => reject(new Error(`ffmpeg silencedetect spawn failed: ${err.message}`)))
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg silencedetect failed: ${stderr.slice(-500)}`))
          return
        }
        const silenceStarts: number[] = []
        const silenceEnds: number[] = []
        for (const match of stderr.matchAll(/silence_start:\s*([\d.]+)/g)) {
          silenceStarts.push(parseFloat(match[1]))
        }
        for (const match of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
          silenceEnds.push(parseFloat(match[1]))
        }

        const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        const totalDuration = durMatch
          ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseFloat('0.' + durMatch[4])
          : 0

        const active: { start: number; end: number }[] = []
        let pos = 0
        for (let i = 0; i < silenceStarts.length; i++) {
          if (silenceStarts[i] > pos) {
            active.push({ start: pos, end: silenceStarts[i] })
          }
          pos = silenceEnds[i] ?? silenceStarts[i]
        }
        if (pos < totalDuration) {
          active.push({ start: pos, end: totalDuration })
        }

        resolve(active)
      })
    })
  }

  private async generateSpeakersJson(meetingId: string, transcripts: Transcript[]): Promise<void> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const speakersPath = join(meetingDir, 'speakers.json')

    const speakerIds = new Set(transcripts.map((t) => t.speaker))

    let suggestions: string[] = []
    try {
      if (this.calendarManager.isConnected()) {
        const metadata = await readMetadata(meetingDir)
        if (metadata?.startedAt) {
          const events = await this.calendarManager.fetchAllRecentEvents(30)
          const matched = matchCalendarEvent(events, metadata.startedAt)
          if (matched) {
            suggestions = matched.attendees
          }
        }
      }
    } catch {
      // Calendar fetch failed
    }

    const speakerMap: SpeakerMap = {}
    let speakerNum = 0
    for (const id of speakerIds) {
      if (id === 'me') {
        speakerMap[id] = { label: 'Me' }
      } else if (id === 'them') {
        speakerMap[id] = {
          label: 'Them',
          ...(suggestions.length > 0 ? { suggestions } : {}),
        }
      } else if (id === 'Speaker') {
        // Legacy un-diarized segment, skip
        continue
      } else {
        speakerNum++
        speakerMap[id] = {
          label: `Speaker ${speakerNum}`,
          ...(suggestions.length > 0 ? { suggestions } : {}),
        }
      }
    }

    await encryptJSON(speakerMap, speakersPath)
  }

  private async transcribeWithFallback(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec: number | undefined,
    tempPrefix: string,
    tempFiles: string[],
  ): Promise<WhisperOutput> {
    if (audioDurationSec && audioDurationSec >= CHUNKED_TRANSCRIPTION_THRESHOLD_SEC) {
      console.log(`[transcription] Using chunked whisper for long recording (${meetingId}, ${audioDurationSec.toFixed(1)}s)`)
      return await this.runWhisperChunked(audioWavPath, meetingId, audioDurationSec, tempPrefix, tempFiles)
    }

    const output = await this.runWhisperPassAndRead(audioWavPath, meetingId, audioDurationSec, tempFiles)
    const mapped = this.mapToTranscripts(meetingId, output)
    if (audioDurationSec && this.hasSuspiciousRepetition(mapped)) {
      console.warn(`[transcription] Detected repetition loop, retrying in chunks (${meetingId})`)
      return await this.runWhisperChunked(audioWavPath, meetingId, audioDurationSec, tempPrefix, tempFiles)
    }

    return output
  }

  private async runWhisperChunked(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec: number,
    tempPrefix: string,
    tempFiles: string[],
  ): Promise<WhisperOutput> {
    const stepSec = Math.max(1, CHUNKED_TRANSCRIPTION_WINDOW_SEC - CHUNKED_TRANSCRIPTION_OVERLAP_SEC)
    const transcription: WhisperSegment[] = []
    let lastAcceptedTo = 0
    let chunkIndex = 0

    for (let chunkStart = 0; chunkStart < audioDurationSec; chunkStart += stepSec) {
      const chunkDuration = Math.min(CHUNKED_TRANSCRIPTION_WINDOW_SEC, audioDurationSec - chunkStart)
      const chunkPath = `${tempPrefix}-chunk-${chunkIndex}.wav`
      tempFiles.push(chunkPath)

      await this.audioConverter.extractClip(
        audioWavPath,
        chunkPath,
        this.whisperManager.getFfmpegPath(),
        chunkStart,
        chunkDuration,
      )

      const progressRange = {
        start: Math.round((chunkStart / audioDurationSec) * 100),
        end: Math.round((Math.min(chunkStart + chunkDuration, audioDurationSec) / audioDurationSec) * 100),
      }
      const chunkOutput = await this.runWhisperPassAndRead(
        chunkPath,
        meetingId,
        chunkDuration,
        tempFiles,
        progressRange,
        ['-ml', String(CHUNKED_TRANSCRIPTION_MAX_SEGMENT_CHARS), '-sow'],
      )

      const adjustedSegments = chunkOutput.transcription
        .map((segment) => ({
          offsets: {
            from: segment.offsets.from + Math.round(chunkStart * 1000),
            to: segment.offsets.to + Math.round(chunkStart * 1000),
          },
          text: segment.text,
        }))
        .sort((a, b) => a.offsets.from - b.offsets.from)

      for (const segment of adjustedSegments) {
        if (segment.offsets.to <= lastAcceptedTo) continue
        const prev = transcription[transcription.length - 1]
        if (
          prev &&
          this.normalizeTranscriptText(prev.text) === this.normalizeTranscriptText(segment.text) &&
          segment.offsets.from <= prev.offsets.to + 1500
        ) {
          prev.offsets.to = Math.max(prev.offsets.to, segment.offsets.to)
          lastAcceptedTo = Math.max(lastAcceptedTo, prev.offsets.to)
          continue
        }

        transcription.push(segment)
        lastAcceptedTo = Math.max(lastAcceptedTo, segment.offsets.to)
      }

      chunkIndex++
    }

    return { transcription }
  }

  private async runWhisperPassAndRead(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec: number | undefined,
    tempFiles: string[],
    progressRange?: { start: number; end: number },
    extraArgs: string[] = [],
  ): Promise<WhisperOutput> {
    const jsonPath = `${audioWavPath}.json`
    tempFiles.push(jsonPath)
    await this.runWhisperPass(audioWavPath, meetingId, audioDurationSec, progressRange, extraArgs)
    const whisperJson = await readFile(jsonPath, 'utf-8')
    return JSON.parse(whisperJson) as WhisperOutput
  }

  private runWhisperPass(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec?: number,
    progressRange?: { start: number; end: number },
    extraArgs: string[] = [],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      const threadCount = this.getWhisperThreadCount()
      const args = [
        '-m', this.whisperManager.getModelPath(),
        '-f', audioWavPath,
        '-oj',
        '-l', 'en',
        '-pp',
      ]

      if (threadCount !== null) {
        args.splice(4, 0, '-t', String(threadCount))
      }

      args.push(...extraArgs)

      const proc = spawn(this.whisperManager.getWhisperPath(), args)

      if (threadCount !== null) {
        console.log(`[perf] Whisper threads: ${threadCount} (${meetingId})`)
      }
      this.lowerWhisperPriority(proc.pid, meetingId)

      proc.on('error', (err) => {
        reject(new Error(`whisper spawn failed: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        // Parse whisper.cpp progress: "whisper_print_progress_callback: progress = 42%"
        const match = chunk.match(/progress\s*=\s*(\d+)%/)
        if (match) {
          const progress = this.scaleProgress(parseInt(match[1], 10), progressRange)
          this.broadcastStatus(meetingId, 'transcribing', progress)
        }
      })

      // Also parse stdout timestamps for more granular progress on short recordings
      // Whisper outputs lines like: [00:01:30.000 --> 00:01:59.980]
      if (audioDurationSec && audioDurationSec > 0) {
        proc.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString()
          const tsMatch = chunk.match(/\[(\d+):(\d+):(\d+)\.\d+\s*-->/)
          if (tsMatch) {
            const h = parseInt(tsMatch[1], 10)
            const m = parseInt(tsMatch[2], 10)
            const s = parseInt(tsMatch[3], 10)
            const currentSec = h * 3600 + m * 60 + s + 30 // +30 since this segment is being completed
            const progress = this.scaleProgress(
              Math.min(99, Math.round((currentSec / audioDurationSec) * 100)),
              progressRange,
            )
            this.broadcastStatus(meetingId, 'transcribing', progress)
          }
        })
      }

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }

  private getWhisperThreadCount(): number | null {
    if (process.platform !== 'win32') {
      return null
    }

    const logicalProcessors = this.getLogicalProcessorCount()
    return Math.max(
      MIN_WHISPER_THREADS,
      Math.min(MAX_WHISPER_THREADS, logicalProcessors - RESERVED_LOGICAL_CPUS),
    )
  }

  private getLogicalProcessorCount(): number {
    try {
      if (typeof availableParallelism === 'function') {
        return Math.max(1, availableParallelism())
      }
    } catch {
      // Fall back to cpu count below.
    }

    try {
      return Math.max(1, cpus().length)
    } catch {
      return MIN_WHISPER_THREADS
    }
  }

  private lowerWhisperPriority(pid: number | undefined, meetingId: string): void {
    if (process.platform !== 'win32' || !pid) {
      return
    }

    try {
      setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
      console.log(`[perf] Whisper priority: BelowNormal (${meetingId})`)
    } catch (err) {
      console.warn(`Failed to lower whisper priority for ${meetingId}:`, err)
    }
  }

  private scaleProgress(progress: number, progressRange?: { start: number; end: number }): number {
    if (!progressRange) return progress
    const clamped = Math.max(0, Math.min(100, progress))
    return Math.max(
      progressRange.start,
      Math.min(
        99,
        Math.round(progressRange.start + ((progressRange.end - progressRange.start) * clamped) / 100),
      ),
    )
  }

  private mapToTranscripts(meetingId: string, output: WhisperOutput): Transcript[] {
    const raw = output.transcription.map((seg, index) => ({
      id: `${meetingId}-${index}`,
      meetingId,
      speaker: 'Speaker',
      text: seg.text.trim(),
      startMs: seg.offsets.from,
      endMs: seg.offsets.to,
      confidence: -1,
    }))

    // Remove consecutive duplicate segments (Whisper hallucination loops)
    const deduped: Transcript[] = []
    for (const seg of raw) {
      if (seg.text === '') continue
      const prev = deduped[deduped.length - 1]
      if (prev && prev.text === seg.text) continue
      deduped.push(seg)
    }

    // Re-index IDs after dedup
    return deduped.map((seg, i) => ({ ...seg, id: `${meetingId}-${i}` }))
  }

  private hasSuspiciousRepetition(transcripts: Transcript[]): boolean {
    if (transcripts.length < REPETITION_WINDOW_SEGMENTS) return false

    for (let i = 0; i <= transcripts.length - REPETITION_WINDOW_SEGMENTS; i++) {
      const window = transcripts.slice(i, i + REPETITION_WINDOW_SEGMENTS)
      const normalized = window
        .map((segment) => this.normalizeTranscriptText(segment.text))
        .filter((segment) => segment.length > 0)

      if (normalized.length < REPETITION_WINDOW_SEGMENTS) continue

      const counts = new Map<string, number>()
      for (const segment of normalized) {
        counts.set(segment, (counts.get(segment) ?? 0) + 1)
      }

      const repeatedCoverage = [...counts.values()]
        .sort((a, b) => b - a)
        .slice(0, 3)
        .reduce((sum, count) => sum + count, 0) / normalized.length
      if (
        counts.size <= REPETITION_WINDOW_MAX_UNIQUE &&
        repeatedCoverage >= REPETITION_WINDOW_MIN_RATIO
      ) {
        return true
      }
    }

    return false
  }

  private normalizeTranscriptText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s.]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private async markFailed(
    meetingId: string,
    error: Error | string,
    context?: TranscriptionDirSnapshot,
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : error
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    const existing = await this.readErrorFile(errorPath)
    const errorCode = classifyError(errorMsg)
    const isPermanentFailure = errorCode === 'key-mismatch' || errorCode === 'encryption-key-unavailable'
    const retries = isPermanentFailure ? 3 : (existing?.retries ?? 0) + 1
    try {
      await writeFile(errorPath, JSON.stringify({ error: errorMsg, retries }))
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: string }).code) : null
      if (code !== 'ENOENT') throw err
    }
    logAutodocFailure({
      area: 'transcription',
      message: 'Transcription failed',
      error,
      meetingId,
      context,
    })
    this.broadcastStatus(meetingId, 'failed', undefined, classifyError(errorMsg))
  }

  private async readErrorFile(errorPath: string): Promise<{ error: string; retries: number } | null> {
    try {
      const raw = await readFile(errorPath, 'utf-8')
      // Handle legacy plain-text error files
      try {
        return JSON.parse(raw)
      } catch {
        return { error: raw, retries: 0 }
      }
    } catch {
      return null
    }
  }

  private broadcastStatus(
    meetingId: string,
    status: TranscriptionStatus,
    progress?: number,
    errorCode?: string,
  ): void {
    this.activeProgress = progress
    const windows = BrowserWindow.getAllWindows()
    const payload: TranscriptionStatusPayload = { meetingId, status, progress, errorCode }
    for (const win of windows) {
      win.webContents.send('transcription:status-changed', payload)
    }
  }

  private async captureDirSnapshot(meetingId: string): Promise<TranscriptionDirSnapshot> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')
    const micWebm = join(meetingDir, 'mic.webm')
    const systemWebm = join(meetingDir, 'system.webm')
    const legacyAudio = join(meetingDir, 'audio.webm')
    const errorPath = join(meetingDir, 'transcript.error')
    const [hasMic, hasSystem, hasLegacy, existingError] = await Promise.all([
      this.fileExists(micWebm),
      this.fileExists(systemWebm),
      this.fileExists(legacyAudio),
      this.readErrorFile(errorPath),
    ])

    return {
      source: this.enqueueSource.get(meetingId) ?? 'unknown',
      files: {
        micExists: hasMic,
        micEncrypted: hasMic && await isEncrypted(micWebm),
        systemExists: hasSystem,
        systemEncrypted: hasSystem && await isEncrypted(systemWebm),
        legacyExists: hasLegacy,
        legacyEncrypted: hasLegacy && await isEncrypted(legacyAudio),
        screenExists: await this.fileExists(join(meetingDir, 'screen.webm')),
        transcriptExists: await this.fileExists(transcriptPath),
        segmentsExists: await this.fileExists(join(meetingDir, 'segments.json')),
        errorExists: await this.fileExists(errorPath),
        metadataExists: await this.fileExists(join(meetingDir, 'metadata.json')),
      },
      retryCount: existingError?.retries ?? 0,
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
