import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { availableParallelism, constants as osConstants, cpus, setPriority, tmpdir } from 'os'
import { spawn } from 'child_process'
import type {
  Transcript,
  TranscriptionStatus,
  SpeakerMap,
  TranscriptionStatusPayload
} from '../../shared/types'
import type { WhisperManager } from './whisper-manager'
import type { AudioConverter } from './audio-converter'
import { matchCalendarEvent, readMetadata } from './calendar-matcher'
import {
  encryptJSON,
  decryptJSON,
  decryptFileToTemp,
  isEncrypted,
  encryptFileInPlace
} from './crypto'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import type { CalendarManager } from './calendar-manager'
import { classifyError } from './error-classification'
import { filterLowSignalHallucinations, summarizeSpeechSignal } from './transcript-guardrails'
import { alignSpeakers } from './speaker-alignment'
import type { DiarizationResult, DiarizationService } from './diarization'
import type { LocalProcessingCoordinator } from './local-processing-coordinator'
import {
  detectMacHardwareSnapshot,
  isMemoryHealthyForConcurrentProcessing
} from './mac-processing-profile'
import { shouldSerializeWindowsLocalProcessing } from './windows-transcription-runtime'
import { TranscriptionWorkerClient } from './transcription-worker-client'

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
const TRANSCRIPTION_LANGUAGE = 'en'
const PARAKEET_SINGLE_PASS_MAX_DURATION_SEC = 3 * 60 * 60
const WINDOWS_MEMORY_GATE_HEADROOM_GIB = 1
const WINDOWS_MEMORY_GATE_POLL_INTERVAL_MS = 5000
const WINDOWS_MEMORY_GATE_MAX_WAIT_MS = 60000
const CHUNKED_TRANSCRIPTION_THRESHOLD_SEC = 20 * 60
const CHUNKED_TRANSCRIPTION_WINDOW_SEC = 90
const CHUNKED_TRANSCRIPTION_OVERLAP_SEC = 5
const WORKER_CHUNK_WINDOW_SEC = 600
const WORKER_CHUNK_OVERLAP_SEC = 15
const CHUNKED_TRANSCRIPTION_MAX_SEGMENT_CHARS = 120
const REPETITION_WINDOW_SEGMENTS = 24
const REPETITION_WINDOW_MAX_UNIQUE = 4
const REPETITION_WINDOW_MIN_RATIO = 0.8
const CROSS_SPEAKER_DUPLICATE_LOOKBACK_MS = 6_000
const CROSS_SPEAKER_MIN_OVERLAP_MS = 100
const CROSS_SPEAKER_MIN_SHARED_WORDS = 3
const CROSS_SPEAKER_MIN_CONTAINMENT = 0.65
const CROSS_SPEAKER_MIN_OVERLAP_RATIO = 0.3
const ECHO_SUPPRESSION_WINDOW_MS = 4_000
const ECHO_SUPPRESSION_LEAD_MS = 2_000
const ECHO_MAX_REFERENCE_SEGMENTS = 3
const ECHO_MIN_WORD_COUNT = 3
const ECHO_MIN_CHAR_COUNT = 15
const ECHO_JACCARD_THRESHOLD = 0.5
const ECHO_CONTAINMENT_THRESHOLD = 0.8
const ECHO_TRIGRAM_THRESHOLD = 0.55
const STITCH_ADJACENT_GAP_MS = 900
const STITCH_MAX_COMBINED_CHARS = 240
const DIARIZATION_WINDOW_CONTEXT_SEC = 0.75
const DIARIZATION_WINDOW_MERGE_GAP_SEC = 1.5
const DIARIZATION_COMPACTION_THRESHOLD_SEC = 300
const DIARIZATION_MIN_REDUCTION_RATIO = 0.08
type EnqueueSource = 'direct' | 'recovery-scan'
type TranscriptionPerformanceMode = 'balanced' | 'fast'

interface SystemMemorySnapshot {
  freeGiB: number | null
  totalGiB: number | null
}

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

interface DiarizationWindowMapping {
  compactStart: number
  compactEnd: number
  originalStart: number
  originalEnd: number
}

export class TranscriptionService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeStatus: TranscriptionStatus | null = null
  private activeProgress: number | undefined = undefined
  private processing = false
  private onCompleteCallback: ((meetingId: string) => void) | null = null
  private enqueueSource = new Map<string, EnqueueSource>()
  private getPerformanceMode: () => TranscriptionPerformanceMode
  private memoryGateDelay: (ms: number) => Promise<void>
  private readSystemMemoryInfo: () => SystemMemorySnapshot
  private transcriptionWorkerClient: TranscriptionWorkerClient | null = null
  private transcriptionWorkerClientFingerprint: string | null = null
  private workerLoadedFingerprint: string | null = null

  constructor(
    private whisperManager: WhisperManager,
    private audioConverter: AudioConverter,
    private recordingsBaseDir: string,
    private calendarManager: CalendarManager,
    private isMeetingActive: (meetingId: string) => boolean = () => false,
    private diarizationService: Pick<DiarizationService, 'diarize'> | null = null,
    private isExperimentalSpeakerDiarizationEnabled: () => boolean = () => false,
    private localProcessingCoordinator: LocalProcessingCoordinator | null = null,
    getPerformanceMode: () => TranscriptionPerformanceMode = () => 'balanced',
    memoryGateDelay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    readSystemMemoryInfo?: () => SystemMemorySnapshot
  ) {
    this.getPerformanceMode = getPerformanceMode
    this.memoryGateDelay = memoryGateDelay
    this.readSystemMemoryInfo = readSystemMemoryInfo ?? (() => this.getSystemMemoryInfo())
  }

  onComplete(callback: (meetingId: string) => void): void {
    this.onCompleteCallback = callback
  }

  shutdown(): void {
    this.transcriptionWorkerClient?.dispose()
    this.transcriptionWorkerClient = null
    this.transcriptionWorkerClientFingerprint = null
    this.workerLoadedFingerprint = null
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

  private getNextProgress(status: TranscriptionStatus, progress?: number): number | undefined {
    if (status !== 'transcribing' || progress == null) {
      return progress
    }

    const baseline =
      this.activeStatus === 'transcribing' && this.activeProgress != null
        ? this.activeProgress
        : undefined

    return baseline == null ? progress : Math.max(baseline, progress)
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
        stat(errorPath).catch(() => null)
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
        const systemPath = join(meetingDir, 'system.webm')
        const transcriptPath = join(meetingDir, 'transcript.json')
        const errorPath = join(meetingDir, 'transcript.error')

        const hasAudio =
          (await this.fileExists(audioPath)) ||
          (await this.fileExists(micPath)) ||
          (await this.fileExists(systemPath))
        const hasTranscript = await this.fileExists(transcriptPath)
        const hasError = await this.fileExists(errorPath)

        if (hasAudio && !hasTranscript && !hasError) {
          this.enqueue(meetingId, 'recovery-scan')
        } else if (hasAudio && !hasTranscript && hasError) {
          const errorData = await this.readErrorFile(errorPath)
          const errorCode = errorData ? classifyError(errorData.error) : 'unknown'
          const isPermanentFailure =
            errorCode === 'key-mismatch' || errorCode === 'encryption-key-unavailable'
          const allowsRecoveryScanRetry = this.allowsRecoveryScanRetry(errorCode)
          if (
            errorData &&
            errorData.retries < 3 &&
            !isPermanentFailure &&
            allowsRecoveryScanRetry
          ) {
            console.log(
              `Auto-retrying transcription for ${meetingId} (attempt ${errorData.retries + 1}/3)`
            )
            this.retry(meetingId, 'recovery-scan')
          }
        }
      } catch (err) {
        console.warn(`Failed to inspect transcription state for ${meetingId}:`, err)
        logAutodocFailure({
          area: 'transcription',
          message: 'Failed to inspect transcription state during pending scan',
          error: err,
          meetingId
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
    const localProcessingCoordinator = this.localProcessingCoordinator
    if (localProcessingCoordinator && (await localProcessingCoordinator.isSerializing())) {
      return await localProcessingCoordinator.runExclusive('transcription', meetingId, () =>
        this.processJobExclusive(meetingId)
      )
    }

    return await this.processJobExclusive(meetingId)
  }

  private async processJobExclusive(meetingId: string): Promise<void> {
    if (this.isMeetingActive(meetingId)) {
      console.log(`Skipping transcription for active recording: ${meetingId}`)
      return
    }

    const transcriptionStartedAt = Date.now()
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')

    const micWebm = join(meetingDir, 'mic.webm')
    const systemWebm = join(meetingDir, 'system.webm')
    const legacyAudio = join(meetingDir, 'audio.webm')

    const hasMic = await this.fileExists(micWebm)
    const hasSystem = await this.fileExists(systemWebm)
    const hasLegacy = await this.fileExists(legacyAudio)

    if (!hasMic && !hasSystem && !hasLegacy) {
      return
    }

    const tempPrefix = join(tmpdir(), `autodoc-${meetingId}-${Date.now()}`)
    const tempFiles: string[] = []

    try {
      const source = this.enqueueSource.get(meetingId) ?? 'direct'
      logAutodocEvent({
        area: 'transcription',
        message: 'transcription started',
        meetingId,
        context: {
          source,
          hasMic,
          hasSystem,
          hasLegacy,
          processingProfile: this.getProcessingProfileLogContext()
        }
      })

      if (!(await this.whisperManager.isReady())) {
        this.activeStatus = 'downloading'
        this.broadcastStatus(meetingId, 'downloading')
        await this.whisperManager.ensureReady()
      }

      this.activeStatus = 'transcribing'
      this.broadcastStatus(meetingId, 'transcribing')

      const shouldUseExperimentalDiarization =
        this.diarizationService != null && this.isExperimentalSpeakerDiarizationEnabled()
      let transcripts: Transcript[] = []
      if (hasMic && hasSystem) {
        const shouldDiarizeSystem = shouldUseExperimentalDiarization
        let micTranscripts: Transcript[]
        let rawSystemTranscripts: Transcript[]
        const dualSourceMode = await this.getDualSourceMode()
        logAutodocEvent({
          area: 'transcription',
          message: 'dual-source transcription mode selected',
          meetingId,
          context: {
            mode: dualSourceMode,
            processingProfile: this.getProcessingProfileLogContext()
          }
        })
        if (dualSourceMode === 'concurrent') {
          ;[micTranscripts, rawSystemTranscripts] = await Promise.all([
            this.transcribeAudioSource(
              meetingId,
              micWebm,
              'me',
              `${tempPrefix}-mic`,
              tempFiles,
              {
                start: 0,
                end: 50
              },
              true,
              2
            ),
            this.transcribeAudioSource(
              meetingId,
              systemWebm,
              'them',
              `${tempPrefix}-system`,
              tempFiles,
              { start: 50, end: 100 },
              !shouldDiarizeSystem,
              2
            )
          ])
        } else {
          console.log(`[transcription] Sequential dual-source transcription (${meetingId})`)
          micTranscripts = await this.transcribeAudioSource(
            meetingId,
            micWebm,
            'me',
            `${tempPrefix}-mic`,
            tempFiles,
            { start: 0, end: 50 }
          )
          rawSystemTranscripts = await this.transcribeAudioSource(
            meetingId,
            systemWebm,
            'them',
            `${tempPrefix}-system`,
            tempFiles,
            { start: 50, end: 100 },
            !shouldDiarizeSystem
          )
        }
        const systemTranscripts = shouldDiarizeSystem
          ? await this.diarizeTranscriptsForSource(
              meetingId,
              systemWebm,
              rawSystemTranscripts,
              `${tempPrefix}-system-diarization`,
              tempFiles
            )
          : rawSystemTranscripts
        const filteredMicTranscripts = this.suppressAcousticEchoes(
          micTranscripts,
          systemTranscripts
        )
        transcripts = this.mergeTranscriptStreams(
          meetingId,
          filteredMicTranscripts,
          systemTranscripts
        )
      } else {
        const sourcePath = hasMic ? micWebm : hasSystem ? systemWebm : legacyAudio
        const speaker = hasMic ? 'me' : hasSystem ? 'them' : 'Speaker'
        const shouldDiarizeSource = shouldUseExperimentalDiarization && speaker !== 'me'
        transcripts = await this.transcribeAudioSource(
          meetingId,
          sourcePath,
          speaker,
          tempPrefix,
          tempFiles,
          undefined,
          !shouldDiarizeSource
        )
        if (shouldDiarizeSource) {
          transcripts = await this.diarizeTranscriptsForSource(
            meetingId,
            sourcePath,
            transcripts,
            `${tempPrefix}-diarization`,
            tempFiles
          )
        }
      }

      if (transcripts.some((segment) => segment.speaker !== 'Speaker')) {
        await this.generateSpeakersJson(meetingId, transcripts)
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
            meetingId
          })
          console.error(`Failed to encrypt ${filePath}:`, err)
        }
      }

      console.log(
        `[perf] Transcription total: ${((Date.now() - transcriptionStartedAt) / 1000).toFixed(1)}s (${meetingId})`
      )
      logAutodocEvent({
        area: 'transcription',
        message: 'transcription completed',
        meetingId,
        context: {
          elapsedMs: Date.now() - transcriptionStartedAt,
          transcriptCount: transcripts.length,
          processingProfile: this.getProcessingProfileLogContext()
        }
      })

      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete')
      this.onCompleteCallback?.(meetingId)
    } finally {
      for (const f of tempFiles) {
        await unlink(f).catch(() => {})
      }
      await this.logMacResourceSnapshot('transcription resources released', meetingId, {
        tempFileCount: tempFiles.length
      })
    }
  }

  private async logMacResourceSnapshot(
    message: string,
    meetingId: string,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    if (process.platform !== 'darwin') return
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
    const hardware = await detectMacHardwareSnapshot()
    logAutodocEvent({
      area: 'transcription',
      message,
      meetingId,
      context: {
        ...context,
        hardware,
        memoryHealthyForConcurrentProcessing: isMemoryHealthyForConcurrentProcessing(hardware)
      }
    })
  }

  private async decryptIfNeeded(filePath: string, tempFiles: string[]): Promise<string> {
    if (await isEncrypted(filePath)) {
      const temp = await decryptFileToTemp(filePath)
      tempFiles.push(temp)
      return temp
    }
    return filePath
  }

  private async transcribeAudioSource(
    meetingId: string,
    sourcePath: string,
    speaker: string,
    tempPrefix: string,
    tempFiles: string[],
    progressRange?: { start: number; end: number },
    stitch = true,
    concurrentSources = 1
  ): Promise<Transcript[]> {
    const tempAudioWav = `${tempPrefix}.wav`
    tempFiles.push(tempAudioWav)

    const t0 = Date.now()
    const audioInput = await this.decryptIfNeeded(sourcePath, tempFiles)
    await this.audioConverter.convert(audioInput, tempAudioWav, this.whisperManager.getFfmpegPath())

    const audioDuration = await this.audioConverter
      .getDuration(tempAudioWav, this.whisperManager.getFfmpegPath())
      .catch(() => undefined)
    const speechActivity = await this.detectAudioActivity(tempAudioWav).catch((err) => {
      console.warn(`[transcription] Failed to detect audio activity (${meetingId}):`, err)
      return []
    })
    const speechSignal = summarizeSpeechSignal(speechActivity, audioDuration)
    console.log(
      `[perf] Audio conversion: ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId}, speaker=${speaker})`
    )
    logAutodocEvent({
      area: 'transcription',
      message: 'transcription source prepared',
      meetingId,
      context: {
        speaker,
        sourcePath,
        audioDurationSec: audioDuration ?? null,
        audioConversionElapsedMs: Date.now() - t0,
        speechSignal,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })

    if (speechSignal.likelySilent) {
      console.log(
        `[transcription] Skipping whisper for likely silent audio (${meetingId}, speaker=${speaker}, speech=${speechSignal.totalSpeechMs}ms, ratio=${speechSignal.speechRatio.toFixed(3)})`
      )
      return []
    }

    const whisperStart = Date.now()
    logAutodocEvent({
      area: 'transcription',
      message: 'transcription source started',
      meetingId,
      context: {
        speaker,
        backend: this.whisperManager.getTranscriptionBackend(),
        backendLabel: this.whisperManager.getTranscriptionBackendLabel(),
        model: this.whisperManager.getModelName(),
        audioDurationSec: audioDuration ?? null,
        concurrentSources,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
    const whisperOutput = await this.transcribeWithFallback(
      tempAudioWav,
      meetingId,
      audioDuration,
      tempPrefix,
      tempFiles,
      progressRange,
      concurrentSources
    )
    console.log(
      `[perf] Transcription (whisper): ${((Date.now() - whisperStart) / 1000).toFixed(1)}s (${meetingId}, speaker=${speaker})`
    )
    logAutodocEvent({
      area: 'transcription',
      message: 'transcription source completed',
      meetingId,
      context: {
        speaker,
        backend: this.whisperManager.getTranscriptionBackend(),
        model: this.whisperManager.getModelName(),
        elapsedMs: Date.now() - whisperStart,
        rawSegmentCount: whisperOutput.transcription.length,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })

    const transcripts = filterLowSignalHallucinations(
      this.mapToTranscripts(meetingId, whisperOutput),
      speechSignal
    ).map((segment) => ({
      ...segment,
      speaker
    }))

    return stitch ? this.stitchAdjacentTranscriptFragments(transcripts) : transcripts
  }

  private async diarizeTranscriptsForSource(
    meetingId: string,
    sourcePath: string,
    transcripts: Transcript[],
    tempPrefix: string,
    tempFiles: string[]
  ): Promise<Transcript[]> {
    if (!this.diarizationService || transcripts.length === 0) {
      return this.stitchAdjacentTranscriptFragments(transcripts)
    }

    const tempAudioWav = `${tempPrefix}.wav`
    tempFiles.push(tempAudioWav)

    try {
      this.activeStatus = 'diarizing'
      this.broadcastStatus(meetingId, 'diarizing')

      const audioInput = await this.decryptIfNeeded(sourcePath, tempFiles)
      await this.audioConverter.convert(
        audioInput,
        tempAudioWav,
        this.whisperManager.getFfmpegPath()
      )
      const audioDuration = await this.audioConverter
        .getDuration(tempAudioWav, this.whisperManager.getFfmpegPath())
        .catch(() => undefined)
      const diarizationInput = await this.prepareDiarizationInput(
        meetingId,
        tempAudioWav,
        transcripts,
        tempPrefix,
        tempFiles,
        audioDuration
      )

      const diarization = await this.diarizationService.diarize(diarizationInput.wavPath)
      const remappedDiarization = diarizationInput.mapping
        ? this.remapDiarizationResultToOriginalTimeline(diarization, diarizationInput.mapping)
        : diarization
      return this.stitchAdjacentTranscriptFragments(
        alignSpeakers(transcripts, remappedDiarization, null)
      )
    } catch (err) {
      console.warn(
        `[transcription] Diarization failed, keeping existing speaker labels (${meetingId}):`,
        err
      )
      return this.stitchAdjacentTranscriptFragments(transcripts)
    }
  }

  private async prepareDiarizationInput(
    meetingId: string,
    fullAudioWav: string,
    transcripts: Transcript[],
    tempPrefix: string,
    tempFiles: string[],
    audioDurationSec?: number
  ): Promise<{ wavPath: string; mapping: DiarizationWindowMapping[] | null }> {
    const mapping = this.buildDiarizationWindowMappings(transcripts, audioDurationSec)
    if (mapping.length === 0) {
      return { wavPath: fullAudioWav, mapping: null }
    }

    const compactDuration = mapping[mapping.length - 1]?.compactEnd ?? 0
    const originalDuration = audioDurationSec ?? mapping[mapping.length - 1]?.originalEnd ?? 0
    const reductionRatio = originalDuration > 0 ? 1 - compactDuration / originalDuration : 0

    if (
      originalDuration < DIARIZATION_COMPACTION_THRESHOLD_SEC ||
      reductionRatio < DIARIZATION_MIN_REDUCTION_RATIO
    ) {
      return { wavPath: fullAudioWav, mapping: null }
    }

    console.log(
      `[transcription] Compacting diarization input (${meetingId}, windows=${mapping.length}, compact=${compactDuration.toFixed(1)}s/${originalDuration.toFixed(1)}s)`
    )

    const clipPaths: string[] = []
    for (const [index, window] of mapping.entries()) {
      const clipPath = `${tempPrefix}-clip-${index}.wav`
      tempFiles.push(clipPath)
      clipPaths.push(clipPath)
      await this.audioConverter.extractClip(
        fullAudioWav,
        clipPath,
        this.whisperManager.getFfmpegPath(),
        window.originalStart,
        window.originalEnd - window.originalStart
      )
    }

    if (clipPaths.length === 1) {
      return { wavPath: clipPaths[0], mapping }
    }

    const compactPath = `${tempPrefix}-compact.wav`
    const concatListPath = `${tempPrefix}-concat.txt`
    tempFiles.push(compactPath, concatListPath)
    await this.audioConverter.concatClips(
      clipPaths,
      compactPath,
      this.whisperManager.getFfmpegPath(),
      concatListPath
    )

    return { wavPath: compactPath, mapping }
  }

  private buildDiarizationWindowMappings(
    transcripts: Transcript[],
    audioDurationSec?: number
  ): DiarizationWindowMapping[] {
    const windows = transcripts
      .map((segment) => ({
        start: Math.max(0, segment.startMs / 1000 - DIARIZATION_WINDOW_CONTEXT_SEC),
        end: segment.endMs / 1000 + DIARIZATION_WINDOW_CONTEXT_SEC
      }))
      .filter((window) => window.end > window.start)
      .sort((a, b) => a.start - b.start)

    if (windows.length === 0) {
      return []
    }

    const merged: Array<{ start: number; end: number }> = []
    for (const window of windows) {
      const boundedEnd =
        audioDurationSec == null ? window.end : Math.min(window.end, audioDurationSec)
      if (boundedEnd <= window.start) {
        continue
      }

      const previous = merged[merged.length - 1]
      if (!previous || window.start > previous.end + DIARIZATION_WINDOW_MERGE_GAP_SEC) {
        merged.push({ start: window.start, end: boundedEnd })
        continue
      }

      previous.end = Math.max(previous.end, boundedEnd)
    }

    let compactCursor = 0
    return merged.map((window) => {
      const duration = window.end - window.start
      const mapping = {
        compactStart: compactCursor,
        compactEnd: compactCursor + duration,
        originalStart: window.start,
        originalEnd: window.end
      }
      compactCursor += duration
      return mapping
    })
  }

  private remapDiarizationResultToOriginalTimeline(
    diarization: DiarizationResult,
    mapping: DiarizationWindowMapping[]
  ): DiarizationResult {
    return {
      speakers: diarization.speakers
        .map((speaker) => ({
          id: speaker.id,
          segments: this.mergeDiarizationSegments(
            speaker.segments.flatMap((segment) =>
              mapping.flatMap((window) => {
                const overlapStart = Math.max(segment.start, window.compactStart)
                const overlapEnd = Math.min(segment.end, window.compactEnd)
                if (overlapEnd <= overlapStart) {
                  return []
                }

                return [
                  {
                    start: Number(
                      (window.originalStart + overlapStart - window.compactStart).toFixed(3)
                    ),
                    end: Number(
                      (window.originalStart + overlapEnd - window.compactStart).toFixed(3)
                    )
                  }
                ]
              })
            )
          )
        }))
        .filter((speaker) => speaker.segments.length > 0)
    }
  }

  private mergeDiarizationSegments(
    segments: Array<{ start: number; end: number }>
  ): Array<{ start: number; end: number }> {
    if (segments.length <= 1) {
      return segments
    }

    const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
    const merged: Array<{ start: number; end: number }> = []

    for (const segment of sorted) {
      const previous = merged[merged.length - 1]
      if (!previous || segment.start > previous.end + 0.05) {
        merged.push({ ...segment })
        continue
      }

      previous.end = Math.max(previous.end, segment.end)
    }

    return merged
  }

  private mergeTranscriptStreams(meetingId: string, ...streams: Transcript[][]): Transcript[] {
    const merged = streams
      .flat()
      .filter((segment) => segment.text.trim() !== '')
      .sort(
        (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.speaker.localeCompare(b.speaker)
      )

    const deduped: Transcript[] = []
    for (const segment of merged) {
      let duplicateIndex = -1

      for (let index = deduped.length - 1; index >= 0; index--) {
        const existing = deduped[index]
        if (existing.endMs < segment.startMs - CROSS_SPEAKER_DUPLICATE_LOOKBACK_MS) {
          break
        }

        if (!this.areLikelyDuplicateSegments(existing, segment)) {
          continue
        }

        duplicateIndex = index
        break
      }

      if (duplicateIndex >= 0) {
        const existing = deduped[duplicateIndex]
        deduped[duplicateIndex] = this.pickPreferredDuplicateSegment(existing, segment)
        continue
      }

      deduped.push(segment)
    }

    return deduped.map((segment, index) => ({
      ...segment,
      id: `${meetingId}-${index}`
    }))
  }

  private suppressAcousticEchoes(
    micTranscripts: Transcript[],
    systemTranscripts: Transcript[]
  ): Transcript[] {
    if (micTranscripts.length === 0 || systemTranscripts.length === 0) {
      return micTranscripts
    }

    return micTranscripts.filter((micSegment) => {
      if (!this.isEchoEligibleSegment(micSegment)) {
        return true
      }

      const nearbySystemSegments = systemTranscripts.filter(
        (systemSegment) =>
          systemSegment.endMs >= micSegment.startMs - ECHO_SUPPRESSION_WINDOW_MS &&
          systemSegment.startMs <= micSegment.endMs + ECHO_SUPPRESSION_LEAD_MS
      )

      if (nearbySystemSegments.length === 0) {
        return true
      }

      return !this.hasEchoReferenceMatch(micSegment, nearbySystemSegments)
    })
  }

  private hasEchoReferenceMatch(
    micSegment: Transcript,
    nearbySystemSegments: Transcript[]
  ): boolean {
    const normalizedMic = this.normalizeTranscriptText(micSegment.text)
    if (!normalizedMic) {
      return false
    }

    const systemGroups = this.buildNearbySystemGroups(nearbySystemSegments)
    for (const group of systemGroups) {
      const normalizedSystem = this.normalizeTranscriptText(group.text)
      if (!normalizedSystem) {
        continue
      }

      const metrics = this.getTextSimilarityMetrics(normalizedMic, normalizedSystem)
      if (metrics.shorterWordCount < ECHO_MIN_WORD_COUNT) {
        continue
      }

      if (
        this.isStrongContainmentMatch(normalizedMic, normalizedSystem, metrics.shorterWordCount) ||
        metrics.containment >= ECHO_CONTAINMENT_THRESHOLD ||
        metrics.jaccard >= ECHO_JACCARD_THRESHOLD ||
        (metrics.trigram >= ECHO_TRIGRAM_THRESHOLD &&
          metrics.containment >= CROSS_SPEAKER_MIN_CONTAINMENT)
      ) {
        return true
      }
    }

    return false
  }

  private buildNearbySystemGroups(systemTranscripts: Transcript[]): Array<{
    text: string
    startMs: number
    endMs: number
  }> {
    const groups: Array<{ text: string; startMs: number; endMs: number }> = []

    for (let startIndex = 0; startIndex < systemTranscripts.length; startIndex++) {
      let combinedText = ''
      let groupStartMs = systemTranscripts[startIndex].startMs
      let groupEndMs = systemTranscripts[startIndex].endMs

      for (
        let endIndex = startIndex;
        endIndex < Math.min(systemTranscripts.length, startIndex + ECHO_MAX_REFERENCE_SEGMENTS);
        endIndex++
      ) {
        const segment = systemTranscripts[endIndex]
        combinedText = combinedText ? `${combinedText} ${segment.text}` : segment.text
        groupStartMs = Math.min(groupStartMs, segment.startMs)
        groupEndMs = Math.max(groupEndMs, segment.endMs)
        groups.push({
          text: combinedText,
          startMs: groupStartMs,
          endMs: groupEndMs
        })
      }
    }

    return groups
  }

  private isEchoEligibleSegment(segment: Transcript): boolean {
    const normalized = this.normalizeTranscriptText(segment.text)
    if (!normalized) {
      return false
    }

    const wordCount = normalized.split(' ').filter(Boolean).length
    return wordCount >= ECHO_MIN_WORD_COUNT || normalized.length >= ECHO_MIN_CHAR_COUNT
  }

  private areLikelyDuplicateSegments(a: Transcript, b: Transcript): boolean {
    if (a.speaker === b.speaker) {
      const sameText = this.normalizeTranscriptText(a.text) === this.normalizeTranscriptText(b.text)
      const nearSameTime = Math.abs(a.startMs - b.startMs) <= 1500
      return sameText && nearSameTime
    }

    const overlapMs = this.getOverlapMs(a, b)
    if (overlapMs < CROSS_SPEAKER_MIN_OVERLAP_MS) {
      return false
    }

    const normalizedA = this.normalizeTranscriptText(a.text)
    const normalizedB = this.normalizeTranscriptText(b.text)
    if (!normalizedA || !normalizedB) {
      return false
    }

    if (normalizedA === normalizedB) {
      return true
    }

    const similarity = this.getTextSimilarityMetrics(normalizedA, normalizedB)
    if (similarity.shorterWordCount < CROSS_SPEAKER_MIN_SHARED_WORDS) {
      return false
    }

    if (this.isStrongContainmentMatch(normalizedA, normalizedB, similarity.shorterWordCount)) {
      return true
    }

    if (similarity.containment < CROSS_SPEAKER_MIN_CONTAINMENT) {
      return false
    }

    const shortestDuration = Math.max(1, Math.min(a.endMs - a.startMs, b.endMs - b.startMs))
    const overlapRatio = overlapMs / shortestDuration
    if (overlapRatio < CROSS_SPEAKER_MIN_OVERLAP_RATIO) {
      return false
    }

    return (
      normalizedA.includes(normalizedB) ||
      normalizedB.includes(normalizedA) ||
      similarity.sharedWords >= CROSS_SPEAKER_MIN_SHARED_WORDS + 1 ||
      similarity.jaccard >= ECHO_JACCARD_THRESHOLD
    )
  }

  private pickPreferredDuplicateSegment(a: Transcript, b: Transcript): Transcript {
    const aScore = this.getTranscriptSegmentScore(a)
    const bScore = this.getTranscriptSegmentScore(b)

    if (aScore !== bScore) {
      return aScore > bScore ? a : b
    }

    if (a.startMs !== b.startMs) {
      return a.startMs < b.startMs ? a : b
    }

    if (a.endMs !== b.endMs) {
      return a.endMs > b.endMs ? a : b
    }

    return a
  }

  private getTranscriptSegmentScore(segment: Transcript): number {
    const normalized = this.normalizeTranscriptText(segment.text)
    const wordCount = normalized ? normalized.split(' ').length : 0
    const durationScore = Math.min(20, Math.round((segment.endMs - segment.startMs) / 250))
    return wordCount * 100 + normalized.length + durationScore
  }

  private getOverlapMs(a: Transcript, b: Transcript): number {
    return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))
  }

  private getUniqueWords(text: string): Set<string> {
    return new Set(text.split(' ').filter(Boolean))
  }

  private countSharedWords(a: Set<string>, b: Set<string>): number {
    let shared = 0
    for (const word of a) {
      if (b.has(word)) {
        shared += 1
      }
    }
    return shared
  }

  private getTextSimilarityMetrics(
    a: string,
    b: string
  ): {
    sharedWords: number
    shorterWordCount: number
    containment: number
    jaccard: number
    trigram: number
  } {
    const wordsA = this.getUniqueWords(a)
    const wordsB = this.getUniqueWords(b)
    const sharedWords = this.countSharedWords(wordsA, wordsB)
    const shorterWordCount = Math.min(wordsA.size, wordsB.size)
    const unionSize = wordsA.size + wordsB.size - sharedWords

    return {
      sharedWords,
      shorterWordCount,
      containment: shorterWordCount === 0 ? 0 : sharedWords / shorterWordCount,
      jaccard: unionSize === 0 ? 0 : sharedWords / unionSize,
      trigram: this.getTrigramSimilarity(a, b)
    }
  }

  private isStrongContainmentMatch(a: string, b: string, shorterWordCount: number): boolean {
    if (shorterWordCount < CROSS_SPEAKER_MIN_SHARED_WORDS) {
      return false
    }

    const shorter = a.length <= b.length ? a : b
    const longer = a.length <= b.length ? b : a
    return longer.includes(shorter)
  }

  private getTrigramSimilarity(a: string, b: string): number {
    const trigramsA = this.getCharacterNgrams(a, 3)
    const trigramsB = this.getCharacterNgrams(b, 3)
    if (trigramsA.size === 0 || trigramsB.size === 0) {
      return 0
    }

    const shared = this.countSharedWords(trigramsA, trigramsB)
    const unionSize = trigramsA.size + trigramsB.size - shared
    return unionSize === 0 ? 0 : shared / unionSize
  }

  private getCharacterNgrams(text: string, size: number): Set<string> {
    const compact = text.replace(/\s+/g, ' ').trim()
    if (compact.length < size) {
      return compact ? new Set([compact]) : new Set()
    }

    const grams = new Set<string>()
    for (let index = 0; index <= compact.length - size; index++) {
      grams.add(compact.slice(index, index + size))
    }
    return grams
  }

  private stitchAdjacentTranscriptFragments(transcripts: Transcript[]): Transcript[] {
    if (transcripts.length <= 1) {
      return transcripts
    }

    const stitched: Transcript[] = []

    for (const segment of transcripts) {
      const prev = stitched[stitched.length - 1]
      if (!prev || !this.shouldStitchSegments(prev, segment)) {
        stitched.push({ ...segment })
        continue
      }

      prev.text = this.joinTranscriptText(prev.text, segment.text)
      prev.endMs = Math.max(prev.endMs, segment.endMs)
      prev.confidence = Math.max(prev.confidence, segment.confidence)
    }

    return stitched.map((segment, index) => ({
      ...segment,
      id: `${segment.meetingId}-${index}`
    }))
  }

  private shouldStitchSegments(prev: Transcript, next: Transcript): boolean {
    if (prev.speaker !== next.speaker) {
      return false
    }

    const gapMs = next.startMs - prev.endMs
    if (gapMs < 0 || gapMs > STITCH_ADJACENT_GAP_MS) {
      return false
    }

    const prevText = prev.text.trim()
    const nextText = next.text.trim()
    if (!prevText || !nextText) {
      return false
    }

    if (prevText.length + 1 + nextText.length > STITCH_MAX_COMBINED_CHARS) {
      return false
    }

    if (/[.!?]["')\]]?$/.test(prevText)) {
      return false
    }

    return (
      prevText.length < 140 ||
      /^[a-z]/.test(nextText) ||
      /^(and|but|so|because|then|to|for|with|that|which|who|we|i|it|they|he|she|you)\b/i.test(
        nextText
      )
    )
  }

  private joinTranscriptText(prevText: string, nextText: string): string {
    const left = prevText.trim()
    const right = nextText.trim()
    if (!left) return right
    if (!right) return left
    if (/[-/(\[]$/.test(left)) {
      return `${left}${right}`
    }
    return `${left} ${right}`.replace(/\s+/g, ' ').trim()
  }

  private detectAudioActivity(wavPath: string): Promise<{ start: number; end: number }[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.whisperManager.getFfmpegPath(), [
        '-i',
        wavPath,
        '-af',
        'silencedetect=noise=-30dB:d=0.5',
        '-f',
        'null',
        '-'
      ])
      let stderr = ''
      proc.on('error', (err) =>
        reject(new Error(`ffmpeg silencedetect spawn failed: ${err.message}`))
      )
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
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
          ? parseInt(durMatch[1]) * 3600 +
            parseInt(durMatch[2]) * 60 +
            parseInt(durMatch[3]) +
            parseFloat('0.' + durMatch[4])
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
    if (this.isExperimentalSpeakerDiarizationEnabled()) {
      const orderedSpeakerIds = transcripts
        .map((segment) => segment.speaker)
        .filter(
          (speakerId, index, allSpeakerIds) =>
            speakerId !== 'Speaker' && allSpeakerIds.indexOf(speakerId) === index
        )

      let speakerNum = 0
      orderedSpeakerIds.forEach((speakerId) => {
        if (speakerId === 'me') {
          speakerMap[speakerId] = { label: 'Me' }
          return
        }

        if (speakerId === 'them') {
          speakerMap[speakerId] = {
            label: 'Them',
            ...(suggestions.length > 0 ? { suggestions } : {})
          }
          return
        }

        speakerNum++
        speakerMap[speakerId] = {
          label: `Speaker ${speakerNum}`,
          ...(suggestions.length > 0 ? { suggestions } : {})
        }
      })
    } else {
      let speakerNum = 0
      for (const id of speakerIds) {
        if (id === 'me') {
          speakerMap[id] = { label: 'Me' }
        } else if (id === 'them') {
          speakerMap[id] = {
            label: 'Them',
            ...(suggestions.length > 0 ? { suggestions } : {})
          }
        } else if (id === 'Speaker') {
          // Legacy un-diarized segment, skip
          continue
        } else {
          speakerNum++
          speakerMap[id] = {
            label: `Speaker ${speakerNum}`,
            ...(suggestions.length > 0 ? { suggestions } : {})
          }
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
    progressRange?: { start: number; end: number },
    concurrentSources = 1
  ): Promise<WhisperOutput> {
    const shouldPreChunk =
      audioDurationSec &&
      audioDurationSec >= CHUNKED_TRANSCRIPTION_THRESHOLD_SEC &&
      !this.shouldTrySinglePassForLongRecording(audioDurationSec)

    if (shouldPreChunk) {
      console.log(
        `[transcription] Using chunked whisper for long recording (${meetingId}, ${audioDurationSec.toFixed(1)}s)`
      )
      return await this.runWhisperChunked(
        audioWavPath,
        meetingId,
        audioDurationSec,
        tempPrefix,
        tempFiles,
        progressRange,
        concurrentSources
      )
    }

    const output = await this.runWhisperPassAndRead(
      audioWavPath,
      meetingId,
      audioDurationSec,
      tempFiles,
      progressRange,
      [],
      concurrentSources
    )
    const mapped = this.mapToTranscripts(meetingId, output)
    if (audioDurationSec && this.hasSuspiciousRepetition(mapped)) {
      console.warn(`[transcription] Detected repetition loop, retrying in chunks (${meetingId})`)
      return await this.runWhisperChunked(
        audioWavPath,
        meetingId,
        audioDurationSec,
        tempPrefix,
        tempFiles,
        progressRange,
        concurrentSources,
        true
      )
    }

    return output
  }

  private shouldTrySinglePassForLongRecording(audioDurationSec?: number): boolean {
    if (process.platform !== 'win32') return false

    // Parakeet segments long audio internally via its VAD, so worker chunk
    // windows only add per-window overhead (measured ~6-7 s x 14 windows on a
    // 60-min dual-source run). The repetition fallback below still re-chunks
    // if a single pass produces degenerate output. Whole-file passes load the
    // full waveform into worker RAM (~230 MB/hour), so marathon recordings
    // stay on the windowed path.
    if (
      typeof this.whisperManager.isWorkerEngineSelected === 'function' &&
      this.whisperManager.isWorkerEngineSelected() &&
      typeof this.whisperManager.getWorkerEngine === 'function' &&
      this.whisperManager.getWorkerEngine() === 'parakeet'
    ) {
      return audioDurationSec == null || audioDurationSec <= PARAKEET_SINGLE_PASS_MAX_DURATION_SEC
    }

    if (typeof this.whisperManager.isFasterWhisperSelected !== 'function') return false
    if (!this.whisperManager.isFasterWhisperSelected()) return false
    if (typeof this.whisperManager.getWorkerDevice !== 'function') return false

    return this.whisperManager.getWorkerDevice() === 'cuda'
  }

  private async runWhisperChunked(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec: number,
    tempPrefix: string,
    tempFiles: string[],
    progressRange?: { start: number; end: number },
    concurrentSources = 1,
    useNarrowWindows = false
  ): Promise<WhisperOutput> {
    const useWorkerWindows =
      !useNarrowWindows &&
      typeof this.whisperManager.isWorkerEngineSelected === 'function' &&
      this.whisperManager.isWorkerEngineSelected()
    const chunkWindowSec = useWorkerWindows
      ? WORKER_CHUNK_WINDOW_SEC
      : CHUNKED_TRANSCRIPTION_WINDOW_SEC
    const chunkOverlapSec = useWorkerWindows
      ? WORKER_CHUNK_OVERLAP_SEC
      : CHUNKED_TRANSCRIPTION_OVERLAP_SEC
    const stepSec = Math.max(1, chunkWindowSec - chunkOverlapSec)
    const transcription: WhisperSegment[] = []
    let lastAcceptedTo = 0
    let chunkIndex = 0
    const chunkCount = Math.ceil(audioDurationSec / stepSec)
    const sourceLabel = this.inferSourceLabelFromTempPrefix(tempPrefix)

    for (let chunkStart = 0; chunkStart < audioDurationSec; chunkStart += stepSec) {
      const chunkStartedAt = Date.now()
      const chunkDuration = Math.min(chunkWindowSec, audioDurationSec - chunkStart)
      const chunkPath = `${tempPrefix}-chunk-${chunkIndex}.wav`
      if (!useWorkerWindows) {
        tempFiles.push(chunkPath)
        await this.audioConverter.extractClip(
          audioWavPath,
          chunkPath,
          this.whisperManager.getFfmpegPath(),
          chunkStart,
          chunkDuration
        )
      }
      const extractElapsedMs = Date.now() - chunkStartedAt

      const whisperStartedAt = Date.now()
      const chunkProgressRange = {
        start: Math.round((chunkStart / audioDurationSec) * 100),
        end: Math.round(
          (Math.min(chunkStart + chunkDuration, audioDurationSec) / audioDurationSec) * 100
        )
      }
      const chunkOutput = await this.runWhisperPassAndRead(
        useWorkerWindows ? audioWavPath : chunkPath,
        meetingId,
        chunkDuration,
        tempFiles,
        progressRange
          ? {
              start: this.scaleProgress(chunkProgressRange.start, progressRange),
              end: this.scaleProgress(chunkProgressRange.end, progressRange)
            }
          : chunkProgressRange,
        ['-ml', String(CHUNKED_TRANSCRIPTION_MAX_SEGMENT_CHARS), '-sow'],
        concurrentSources,
        useWorkerWindows ? { startSec: chunkStart, endSec: chunkStart + chunkDuration } : null
      )
      const whisperElapsedMs = Date.now() - whisperStartedAt
      logAutodocEvent({
        area: 'transcription',
        message: 'transcription chunk completed',
        meetingId,
        context: {
          sourceLabel,
          chunkIndex: chunkIndex + 1,
          chunkCount,
          chunkStartSec: Number(chunkStart.toFixed(1)),
          chunkDurationSec: Number(chunkDuration.toFixed(1)),
          extractElapsedMs,
          whisperElapsedMs,
          elapsedMs: Date.now() - chunkStartedAt,
          rawSegmentCount: chunkOutput.transcription.length,
          backend: this.whisperManager.getTranscriptionBackend(),
          model: this.whisperManager.getModelName(),
          concurrentSources
        }
      })

      const adjustedSegments = chunkOutput.transcription
        .map((segment) => ({
          offsets: {
            from: segment.offsets.from + Math.round(chunkStart * 1000),
            to: segment.offsets.to + Math.round(chunkStart * 1000)
          },
          text: segment.text
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

  private inferSourceLabelFromTempPrefix(tempPrefix: string): string {
    if (tempPrefix.includes('-mic')) return 'mic'
    if (tempPrefix.includes('-system')) return 'system'
    return 'single'
  }

  private getFasterWhisperJsonPath(
    audioWavPath: string,
    window: { startSec: number; endSec: number } | null
  ): string {
    if (window) {
      return `${audioWavPath}.window-${window.startSec}-${window.endSec}.json`
    }

    return `${audioWavPath}.json`
  }

  private async runWhisperPassAndRead(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec: number | undefined,
    tempFiles: string[],
    progressRange?: { start: number; end: number },
    extraArgs: string[] = [],
    concurrentSources = 1,
    window: { startSec: number; endSec: number } | null = null
  ): Promise<WhisperOutput> {
    const jsonPath = this.getFasterWhisperJsonPath(audioWavPath, window)
    tempFiles.push(jsonPath)
    if (process.platform === 'win32') {
      await this.waitForWindowsTranscriptionMemory(meetingId)
    }
    await this.runWhisperPass(
      audioWavPath,
      meetingId,
      audioDurationSec,
      progressRange,
      extraArgs,
      concurrentSources,
      window
    )
    const whisperJson = await readFile(jsonPath, 'utf-8')
    return JSON.parse(whisperJson) as WhisperOutput
  }

  private runWhisperPass(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec?: number,
    progressRange?: { start: number; end: number },
    extraArgs: string[] = [],
    concurrentSources = 1,
    window: { startSec: number; endSec: number } | null = null
  ): Promise<void> {
    if (
      typeof this.whisperManager.isMlxWhisperSelected === 'function' &&
      this.whisperManager.isMlxWhisperSelected()
    ) {
      return this.runMlxWhisperPass(audioWavPath, meetingId, audioDurationSec, progressRange)
    }

    if (
      typeof this.whisperManager.isWorkerEngineSelected === 'function' &&
      this.whisperManager.isWorkerEngineSelected()
    ) {
      return this.runWorkerEnginePass(
        audioWavPath,
        meetingId,
        audioDurationSec,
        progressRange,
        concurrentSources,
        window
      )
    }

    const attempt = (disableGpu: boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        let stderr = ''
        const threadCount = this.getWhisperThreadCount(concurrentSources)
        const args = [
          '-m',
          this.whisperManager.getModelPath(),
          '-f',
          audioWavPath,
          '-oj',
          '-l',
          TRANSCRIPTION_LANGUAGE,
          '-pp'
        ]

        if (threadCount !== null) {
          args.splice(4, 0, '-t', String(threadCount))
        }

        args.push(...extraArgs)
        if (disableGpu && !args.includes('--no-gpu')) {
          args.push('--no-gpu')
        }

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
                progressRange
              )
              this.broadcastStatus(meetingId, 'transcribing', progress)
            }
          })
        }

        proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          if (code === 0) {
            resolve()
          } else {
            const signalSuffix = signal ? ` (signal ${signal})` : ''
            reject(
              new Error(
                `whisper.cpp exited with code ${code}${signalSuffix}: ${stderr.slice(-500)}`
              )
            )
          }
        })
      })

    const gpuAlreadyDisabled = extraArgs.includes('--no-gpu')
    return attempt(gpuAlreadyDisabled).catch(async (err) => {
      if (!this.shouldRetryWhisperWithoutGpu(err, extraArgs)) {
        throw err
      }

      logAutodocEvent({
        area: 'transcription',
        message: 'Whisper Metal backend crashed; retrying transcription on CPU',
        meetingId,
        context: {
          audioWavPath,
          audioDurationSec: audioDurationSec ?? null
        }
      })

      return attempt(true)
    })
  }

  private runMlxWhisperPass(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec?: number,
    progressRange?: { start: number; end: number }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      const jsonPath = `${audioWavPath}.json`
      const args = [
        this.whisperManager.getMlxWhisperScriptPath(),
        '--model',
        this.whisperManager.getMlxWhisperModelRef(),
        '--audio',
        audioWavPath,
        '--output',
        jsonPath,
        '--language',
        TRANSCRIPTION_LANGUAGE
      ]

      const proc = spawn(this.whisperManager.getMlxWhisperPythonPath(), args, {
        env: this.whisperManager.getMlxWhisperProcessEnv()
      })
      console.log(
        `[perf] MLX Whisper backend: ${this.whisperManager.getModelName()} (${meetingId})`
      )

      const startedAt = Date.now()
      const progressTimer =
        audioDurationSec && audioDurationSec > 0
          ? setInterval(() => {
              const elapsedSec = (Date.now() - startedAt) / 1000
              const estimatedRatio = Math.min(
                0.95,
                elapsedSec / Math.max(audioDurationSec * 0.3, 30)
              )
              this.broadcastStatus(
                meetingId,
                'transcribing',
                this.scaleProgress(Math.round(estimatedRatio * 100), progressRange)
              )
            }, 1500)
          : null

      proc.on('error', (err) => {
        if (progressTimer) clearInterval(progressTimer)
        reject(new Error(`mlx-whisper spawn failed: ${err.message}`))
      })

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (progressTimer) clearInterval(progressTimer)
        if (code === 0) {
          this.broadcastStatus(meetingId, 'transcribing', this.scaleProgress(99, progressRange))
          resolve()
          return
        }

        const signalSuffix = signal ? ` (signal ${signal})` : ''
        reject(
          new Error(`mlx-whisper exited with code ${code}${signalSuffix}: ${stderr.slice(-500)}`)
        )
      })
    })
  }

  /**
   * The DML (GPU) worker must not be throttled: the heavy compute runs on the
   * GPU, but the parakeet TDT decode loop that feeds it is CPU-side Python.
   * EcoQoS pins that loop to efficiency cores (~5x slowdown measured in
   * Phase 1/3), which defeats the GPU tier's purpose while buying little
   * responsiveness. CPU tiers keep EcoQoS + Low priority in balanced mode.
   */
  private isDmlWorkerSelected(): boolean {
    return (
      typeof this.whisperManager.getWorkerDevice === 'function' &&
      this.whisperManager.getWorkerDevice() === 'dml'
    )
  }

  private getTranscriptionWorkerClientFingerprint(): string {
    return [
      this.whisperManager.getWorkerPythonPath(),
      this.whisperManager.getWorkerModelPath(),
      this.whisperManager.getWorkerDevice(),
      this.whisperManager.getWorkerComputeType(),
      this.whisperManager.getWorkerEngine(),
      // EcoQoS is decided at spawn time (--no-eco), so a performance-mode
      // change must recreate the worker process.
      this.getPerformanceMode()
    ].join('|')
  }

  private getOrCreateTranscriptionWorkerClient(): TranscriptionWorkerClient {
    const fingerprint = this.getTranscriptionWorkerClientFingerprint()
    if (
      this.transcriptionWorkerClient &&
      this.transcriptionWorkerClientFingerprint === fingerprint
    ) {
      return this.transcriptionWorkerClient
    }

    this.transcriptionWorkerClient?.dispose()
    this.transcriptionWorkerClient = new TranscriptionWorkerClient({
      pythonPath: this.whisperManager.getWorkerPythonPath(),
      scriptPath: this.whisperManager.getTranscriptionWorkerScriptPath(),
      processEnv: this.whisperManager.getWorkerProcessEnv(),
      applyPriority: (pid) => this.lowerWhisperPriority(pid, this.activeJobId ?? 'worker'),
      extraArgs:
        this.getPerformanceMode() === 'fast' || this.isDmlWorkerSelected() ? ['--no-eco'] : []
    })
    this.transcriptionWorkerClientFingerprint = fingerprint
    this.workerLoadedFingerprint = null
    return this.transcriptionWorkerClient
  }

  private async ensureWorkerLoaded(concurrentSources: number): Promise<void> {
    const client = this.getOrCreateTranscriptionWorkerClient()
    const threadCount = this.getWhisperThreadCount(concurrentSources)
    // cpu_threads is fixed when the model loads, so a thread-count change
    // (e.g. concurrent dual-source vs single source) requires a reload.
    const fingerprint = `${this.getTranscriptionWorkerClientFingerprint()}|threads=${threadCount}`
    if (client.isLoaded && this.workerLoadedFingerprint === fingerprint) {
      return
    }

    await client.load({
      engine: this.whisperManager.getWorkerEngine(),
      model: this.whisperManager.getWorkerModelPath(),
      device: this.whisperManager.getWorkerDevice(),
      computeType: this.whisperManager.getWorkerComputeType(),
      threads: threadCount
    })
    this.workerLoadedFingerprint = fingerprint
  }

  private async runWorkerEnginePass(
    audioWavPath: string,
    meetingId: string,
    audioDurationSec?: number,
    progressRange?: { start: number; end: number },
    concurrentSources = 1,
    window: { startSec: number; endSec: number } | null = null
  ): Promise<void> {
    const jsonPath = this.getFasterWhisperJsonPath(audioWavPath, window)
    const threadCount = this.getWhisperThreadCount(concurrentSources)
    if (threadCount !== null) {
      console.log(`[perf] Faster Whisper threads: ${threadCount} (${meetingId})`)
    }
    console.log(
      `[perf] Worker transcription backend: ${this.whisperManager.getTranscriptionBackend()} (${meetingId})`
    )

    try {
      await this.ensureWorkerLoaded(concurrentSources)
      const client = this.getOrCreateTranscriptionWorkerClient()
      const result = await client.transcribe(
        {
          audio: audioWavPath,
          language: TRANSCRIPTION_LANGUAGE,
          window
        },
        (segment) => {
          if (audioDurationSec && audioDurationSec > 0) {
            const progress = Math.min(
              99,
              Math.round((segment.endMs / (audioDurationSec * 1000)) * 100)
            )
            this.broadcastStatus(
              meetingId,
              'transcribing',
              this.scaleProgress(progress, progressRange)
            )
          }
        }
      )
      await writeFile(jsonPath, JSON.stringify(result), 'utf-8')
      this.broadcastStatus(meetingId, 'transcribing', this.scaleProgress(99, progressRange))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`faster-whisper exited with code 1: ${message.slice(-500)}`)
    }
  }

  private getWhisperThreadCount(concurrentSources = 1): number | null {
    if (process.platform !== 'win32') {
      return null
    }

    const logicalProcessors = this.getLogicalProcessorCount()
    const reservedProcessors = Math.min(RESERVED_LOGICAL_CPUS, Math.max(2, logicalProcessors - 2))
    const availableProcessors = Math.max(1, logicalProcessors - reservedProcessors)
    const perSourceProcessors = Math.max(1, Math.floor(availableProcessors / concurrentSources))
    const floorCap = this.getPerformanceMode() === 'fast' ? logicalProcessors : availableProcessors
    return Math.min(
      MAX_WHISPER_THREADS,
      Math.max(Math.min(MIN_WHISPER_THREADS, floorCap), perSourceProcessors)
    )
  }

  private async getDualSourceMode(): Promise<'concurrent' | 'sequential'> {
    return (await this.shouldTranscribeDualSourcesConcurrently()) ? 'concurrent' : 'sequential'
  }

  private async shouldTranscribeDualSourcesConcurrently(): Promise<boolean> {
    if (
      process.platform === 'darwin' &&
      typeof this.whisperManager.isMlxWhisperSelected === 'function' &&
      this.whisperManager.isMlxWhisperSelected()
    ) {
      const effectiveProfile = await this.whisperManager.getEffectiveMacProcessingProfile?.()
      if (effectiveProfile) {
        return effectiveProfile.dualSourceMode === 'concurrent'
      }

      const profile = this.whisperManager.getMacProcessingProfile?.()
      if (profile?.dualSourceMode === 'sequential') {
        return false
      }

      const hardware = await detectMacHardwareSnapshot()
      return isMemoryHealthyForConcurrentProcessing(hardware)
    }

    if (process.platform !== 'win32') {
      return true
    }

    const logicalProcessors = this.getLogicalProcessorCount()
    const memoryInfo = this.readSystemMemoryInfo()
    return !shouldSerializeWindowsLocalProcessing(logicalProcessors, memoryInfo.freeGiB)
  }

  private getProcessingProfileLogContext(): Record<string, unknown> | null {
    const profile = this.whisperManager.getMacProcessingProfile?.()
    if (!profile) {
      return null
    }

    return {
      profileId: profile.id,
      reason: profile.reason,
      hardware: profile.hardware,
      settings: {
        transcriptionBackend: profile.transcriptionBackend,
        transcriptionModel: profile.transcriptionModel,
        dualSourceMode: profile.dualSourceMode,
        notesAfterTranscriptionOnly: profile.notesAfterTranscriptionOnly,
        serializeLocalProcessing: profile.serializeLocalProcessing
      }
    }
  }

  private getSystemMemoryInfo(): SystemMemorySnapshot {
    const processWithMemory = process as NodeJS.Process & {
      getSystemMemoryInfo?: () => { free?: number; total?: number }
    }
    const info = processWithMemory.getSystemMemoryInfo?.()
    if (!info) {
      return { freeGiB: null, totalGiB: null }
    }

    return {
      freeGiB: typeof info.free === 'number' ? Number((info.free / 1024 / 1024).toFixed(2)) : null,
      totalGiB:
        typeof info.total === 'number' ? Number((info.total / 1024 / 1024).toFixed(2)) : null
    }
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

    const useBelowNormal = this.getPerformanceMode() === 'fast' || this.isDmlWorkerSelected()
    const priority = useBelowNormal
      ? osConstants.priority.PRIORITY_BELOW_NORMAL
      : osConstants.priority.PRIORITY_LOW
    const label = useBelowNormal ? 'BelowNormal' : 'Low'

    try {
      setPriority(pid, priority)
      console.log(`[perf] Whisper priority: ${label} (pid ${pid}, ${meetingId})`)
    } catch (err) {
      console.warn(`Failed to lower whisper priority for ${meetingId} (pid ${pid}):`, err)
    }
  }

  private async waitForWindowsTranscriptionMemory(meetingId: string): Promise<void> {
    if (process.platform !== 'win32') {
      return
    }

    const estimatedGiB = this.whisperManager.getSelectedWindowsProfileEstimatedMemoryGiB?.()
    if (estimatedGiB == null) {
      return
    }

    const requiredGiB = estimatedGiB + WINDOWS_MEMORY_GATE_HEADROOM_GIB
    const readFreeGiB = (): number | null => this.readSystemMemoryInfo().freeGiB
    const initialFreeGiB = readFreeGiB()
    if (initialFreeGiB != null && initialFreeGiB >= requiredGiB) {
      return
    }

    logAutodocEvent({
      area: 'transcription',
      message: 'Waiting for free memory before starting transcription pass',
      meetingId,
      context: {
        freeGiB: initialFreeGiB,
        requiredGiB
      }
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < WINDOWS_MEMORY_GATE_MAX_WAIT_MS) {
      await this.memoryGateDelay(WINDOWS_MEMORY_GATE_POLL_INTERVAL_MS)
      const freeGiB = readFreeGiB()
      if (freeGiB == null || freeGiB >= requiredGiB) {
        return
      }
    }

    logAutodocEvent({
      area: 'transcription',
      message: 'Proceeding with transcription pass after memory wait timeout',
      meetingId,
      context: {
        freeGiB: readFreeGiB(),
        requiredGiB,
        waitedMs: WINDOWS_MEMORY_GATE_MAX_WAIT_MS
      }
    })
  }

  private shouldRetryWhisperWithoutGpu(error: unknown, extraArgs: string[]): boolean {
    if (process.platform !== 'darwin') return false
    if (extraArgs.includes('--no-gpu')) return false

    const message = error instanceof Error ? error.message : String(error)
    return classifyError(message) === 'whisper-metal-crash'
  }

  private allowsRecoveryScanRetry(errorCode: string): boolean {
    return errorCode !== 'whisper-metal-crash'
  }

  private scaleProgress(progress: number, progressRange?: { start: number; end: number }): number {
    if (!progressRange) return progress
    const clamped = Math.max(0, Math.min(100, progress))
    return Math.max(
      progressRange.start,
      Math.min(
        99,
        Math.round(
          progressRange.start + ((progressRange.end - progressRange.start) * clamped) / 100
        )
      )
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
      confidence: -1
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

      const repeatedCoverage =
        [...counts.values()]
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
    context?: TranscriptionDirSnapshot
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : error
    const errorPath = join(this.recordingsBaseDir, meetingId, 'transcript.error')
    const existing = await this.readErrorFile(errorPath)
    const errorCode = classifyError(errorMsg)
    const isPermanentFailure =
      errorCode === 'key-mismatch' || errorCode === 'encryption-key-unavailable'
    const retries = isPermanentFailure ? 3 : (existing?.retries ?? 0) + 1
    try {
      await writeFile(errorPath, JSON.stringify({ error: errorMsg, retries }))
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : null
      if (code !== 'ENOENT') throw err
    }
    logAutodocFailure({
      area: 'transcription',
      message: 'Transcription failed',
      error,
      meetingId,
      context: {
        ...context,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
    this.broadcastStatus(meetingId, 'failed', undefined, classifyError(errorMsg))
  }

  private async readErrorFile(
    errorPath: string
  ): Promise<{ error: string; retries: number } | null> {
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
    errorCode?: string
  ): void {
    const nextProgress = this.getNextProgress(status, progress)
    this.activeStatus = status
    this.activeProgress = nextProgress
    const windows = BrowserWindow.getAllWindows()
    const payload: TranscriptionStatusPayload = {
      meetingId,
      status,
      progress: nextProgress,
      errorCode
    }
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
      this.readErrorFile(errorPath)
    ])

    return {
      source: this.enqueueSource.get(meetingId) ?? 'unknown',
      files: {
        micExists: hasMic,
        micEncrypted: hasMic && (await isEncrypted(micWebm)),
        systemExists: hasSystem,
        systemEncrypted: hasSystem && (await isEncrypted(systemWebm)),
        legacyExists: hasLegacy,
        legacyEncrypted: hasLegacy && (await isEncrypted(legacyAudio)),
        screenExists: await this.fileExists(join(meetingDir, 'screen.webm')),
        transcriptExists: await this.fileExists(transcriptPath),
        segmentsExists: await this.fileExists(join(meetingDir, 'segments.json')),
        errorExists: await this.fileExists(errorPath),
        metadataExists: await this.fileExists(join(meetingDir, 'metadata.json'))
      },
      retryCount: existingError?.retries ?? 0
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
