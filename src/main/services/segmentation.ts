import { BrowserWindow } from 'electron'
import { access, readFile, writeFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import type {
  MeetingSegments,
  Transcript,
  SegmentationStatus,
  SegmentationStatusPayload
} from '../../shared/types'
import type { LLMProvider } from './llm'
import { encryptJSON, decryptJSON, isEncrypted } from './crypto'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { classifyError } from './error-classification'
import {
  hasUsableTranscriptContent,
  shouldTreatEmptySegmentationAsFailure
} from './transcript-guardrails'
import type { LocalProcessingCoordinator } from './local-processing-coordinator'
import {
  detectMacHardwareSnapshot,
  isMemoryHealthyForConcurrentProcessing,
  type MacProcessingProfile
} from './mac-processing-profile'

type EnqueueSource = 'direct' | 'recovery-scan'
type PersistedSegmentationStatus = Extract<SegmentationStatus, 'failed' | 'no-notes'>
interface OllamaReadiness {
  waitUntilReady(): Promise<void>
}

const EMPTY_SEGMENTATION_ERROR =
  'LLM returned empty segments for non-trivial transcript — likely context overflow or model issue'

interface SegmentationDirSnapshot extends Record<string, unknown> {
  source: EnqueueSource | 'unknown'
  files: {
    transcriptExists: boolean
    transcriptEncrypted: boolean
    segmentsExists: boolean
    errorExists: boolean
  }
  retryCount: number
}

interface PersistedSegmentationError {
  error: string
  retries: number
  status?: PersistedSegmentationStatus
  errorCode?: string
}

export class SegmentationService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeJobSource: EnqueueSource | null = null
  private activeStatus: SegmentationStatus | null = null
  private activeProgress: number | undefined = undefined
  private processing = false
  private enqueueSource = new Map<string, EnqueueSource>()
  private onCompleteCallback: ((meetingId: string) => void) | null = null

  constructor(
    private llmProvider: LLMProvider,
    private ollamaManager: OllamaReadiness,
    private recordingsBaseDir: string,
    private localProcessingCoordinator: LocalProcessingCoordinator | null = null,
    private getMacProcessingProfile: (() => MacProcessingProfile | null) | null = null,
    private getEffectiveMacProcessingProfile:
      | (() => Promise<MacProcessingProfile | null>)
      | null = null
  ) {}

  enqueue(meetingId: string, source: EnqueueSource = 'direct'): void {
    if (this.activeJobId === meetingId) return
    if (this.queue.includes(meetingId)) return
    if (source === 'direct' && this.activeJobId && this.activeJobSource === 'recovery-scan') {
      if (!this.queue.includes(this.activeJobId)) {
        this.enqueueSource.set(this.activeJobId, 'recovery-scan')
        this.queue.push(this.activeJobId)
      }
      this.llmProvider.abortActiveRequests?.('SEGMENTATION_PREEMPTED')
    }
    this.enqueueSource.set(meetingId, source)
    if (source === 'direct') {
      this.queue.unshift(meetingId)
    } else {
      this.queue.push(meetingId)
    }
    this.broadcastStatus(meetingId, 'queued')
    this.processNext()
  }

  retry(meetingId: string, source: EnqueueSource = 'direct'): void {
    this.enqueue(meetingId, source)
  }

  onComplete(callback: (meetingId: string) => void): void {
    this.onCompleteCallback = callback
  }

  getProgress(meetingId: string): number | undefined {
    if (this.activeJobId === meetingId) return this.activeProgress
    return undefined
  }

  async getStatus(meetingId: string): Promise<SegmentationStatus> {
    if (this.activeJobId === meetingId && this.activeStatus) {
      return this.activeStatus
    }
    if (this.queue.includes(meetingId)) {
      return 'queued'
    }
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const segmentsPath = join(meetingDir, 'segments.json')
    const errorPath = join(meetingDir, 'segments.error')
    const hasSegments = await this.fileExists(segmentsPath)
    const hasError = await this.fileExists(errorPath)
    const errorData = hasError ? await this.readErrorFile(errorPath) : null

    if (hasSegments && hasError) {
      const [segmentsStat, errorStat] = await Promise.all([
        stat(segmentsPath).catch(() => null),
        stat(errorPath).catch(() => null)
      ])
      if (segmentsStat && errorStat && errorStat.mtimeMs > segmentsStat.mtimeMs) {
        return this.getPersistedStatus(errorData)
      }
    }

    if (hasSegments) return 'complete'
    if (hasError) return this.getPersistedStatus(errorData)
    return 'pending'
  }

  async getErrorCode(meetingId: string): Promise<string | undefined> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    const errorData = await this.readErrorFile(errorPath)
    return errorData?.errorCode
  }

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

  async saveSegments(meetingId: string, segments: MeetingSegments): Promise<void> {
    const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
    await encryptJSON(segments, segmentsPath)
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
        const meetingDir = join(this.recordingsBaseDir, meetingId)
        const dirStat = await stat(meetingDir).catch(() => null)
        if (!dirStat?.isDirectory()) continue

        const hasTranscript = await this.fileExists(join(meetingDir, 'transcript.json'))
        const hasSegments = await this.fileExists(join(meetingDir, 'segments.json'))
        const hasError = await this.fileExists(join(meetingDir, 'segments.error'))

        if (hasTranscript && !hasSegments && !hasError) {
          this.enqueue(meetingId, 'recovery-scan')
        } else if (hasTranscript && !hasSegments && hasError) {
          const errorData = await this.readErrorFile(join(meetingDir, 'segments.error'))
          const isPermanentFailure = errorData?.errorCode === 'ollama-insufficient-memory'
          if (
            errorData &&
            this.getPersistedStatus(errorData) !== 'no-notes' &&
            errorData.retries < 3 &&
            !isPermanentFailure
          ) {
            console.log(
              `Auto-retrying segmentation for ${meetingId} (attempt ${errorData.retries + 1}/3)`
            )
            this.retry(meetingId, 'recovery-scan')
          }
        }
      } catch (err) {
        console.warn(`Failed to inspect segmentation state for ${meetingId}:`, err)
        logAutodocFailure({
          area: 'segmentation',
          message: 'Failed to inspect segmentation state during pending scan',
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
    this.activeJobSource = this.enqueueSource.get(meetingId) ?? 'direct'
    const dirSnapshot = await this.captureDirSnapshot(meetingId).catch(() => undefined)

    try {
      await this.processJob(meetingId)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.message !== 'SEGMENTATION_PREEMPTED') {
        await this.markFailed(meetingId, error, dirSnapshot)
      }
    } finally {
      this.activeJobId = null
      this.activeJobSource = null
      this.activeStatus = null
      this.processing = false
      this.enqueueSource.delete(meetingId)
      this.processNext()
    }
  }

  private async processJob(meetingId: string): Promise<void> {
    const localProcessingCoordinator = this.localProcessingCoordinator
    if (localProcessingCoordinator && (await localProcessingCoordinator.isSerializing())) {
      return await localProcessingCoordinator.runExclusive('segmentation', meetingId, () =>
        this.processJobExclusive(meetingId)
      )
    }

    return await this.processJobExclusive(meetingId)
  }

  private async processJobExclusive(meetingId: string): Promise<void> {
    const jobStartedAt = Date.now()
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')
    const segmentsPath = join(meetingDir, 'segments.json')

    if (!(await this.fileExists(transcriptPath))) {
      return
    }

    const transcripts: Transcript[] = (await isEncrypted(transcriptPath))
      ? await decryptJSON<Transcript[]>(transcriptPath)
      : JSON.parse(await readFile(transcriptPath, 'utf-8'))

    if (!hasUsableTranscriptContent(transcripts)) {
      await encryptJSON(
        {
          decisions: [],
          actionItems: [],
          information: [],
          discussion: [],
          statusUpdates: []
        },
        segmentsPath
      )
      await unlink(join(meetingDir, 'segments.error')).catch(() => {})
      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete')
      this.safeInvokeOnComplete(meetingId)
      return
    }

    this.activeStatus = 'downloading-model'
    this.broadcastStatus(meetingId, 'downloading-model')
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation waiting for model',
      meetingId,
      context: {
        transcriptCount: transcripts.length,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
    await this.ollamaManager.waitUntilReady()

    this.activeStatus = 'segmenting'
    this.broadcastStatus(meetingId, 'segmenting', 0)
    const macProcessingProfile =
      (await this.getEffectiveMacProcessingProfile?.()) ?? this.getMacProcessingProfile?.()
    if (macProcessingProfile) {
      this.llmProvider.setLowMemoryMode?.(macProcessingProfile.id === 'mac-low-spec')
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes effective processing profile selected',
        meetingId,
        context: {
          profileId: macProcessingProfile.id,
          reason: macProcessingProfile.reason,
          hardware: macProcessingProfile.hardware,
          settings: {
            transcriptionBackend: macProcessingProfile.transcriptionBackend,
            transcriptionModel: macProcessingProfile.transcriptionModel,
            dualSourceMode: macProcessingProfile.dualSourceMode,
            notesAfterTranscriptionOnly: macProcessingProfile.notesAfterTranscriptionOnly,
            serializeLocalProcessing: macProcessingProfile.serializeLocalProcessing
          }
        }
      })
    }

    const t0 = Date.now()
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation started',
      meetingId,
      context: {
        transcriptCount: transcripts.length,
        waitForModelMs: t0 - jobStartedAt,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })

    const fullText = transcripts
      .map((t) => {
        const totalSec = Math.floor(t.startMs / 1000)
        const h = Math.floor(totalSec / 3600)
        const m = Math.floor((totalSec % 3600) / 60)
        const s = totalSec % 60
        const ts =
          h > 0
            ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        return `[${ts}] [${t.speaker}] ${t.text}`
      })
      .join('\n')

    console.log(`[perf] Segmentation input: ${fullText.length} chars (${meetingId})`)

    // Compute actual duration from transcript timestamps
    const lastEntry = transcripts[transcripts.length - 1]
    const durationMinutes = lastEntry
      ? Math.round((lastEntry.endMs || lastEntry.startMs) / 60000)
      : undefined

    let lastBroadcastedPercent = -1
    let segments: MeetingSegments
    try {
      segments = await this.llmProvider.summarize(
        meetingId,
        fullText,
        (percent) => {
          if (percent !== lastBroadcastedPercent) {
            lastBroadcastedPercent = percent
            this.broadcastStatus(meetingId, 'segmenting', percent)
          }
        },
        durationMinutes
      )
    } finally {
      if (process.platform === 'darwin') {
        await this.llmProvider.releaseResources?.(meetingId).catch((error) => {
          logAutodocEvent({
            area: 'segmentation',
            message: 'llm resource release failed',
            meetingId,
            level: 'warn',
            context: {
              error: error instanceof Error ? error.message : String(error),
              processingProfile: this.getProcessingProfileLogContext()
            }
          })
        })
        await this.logMacResourceSnapshot('notes resources released', meetingId)
      }
    }

    // Verify the LLM actually produced content — empty results mean it failed silently
    const totalItems =
      segments.decisions.length +
      segments.actionItems.length +
      segments.information.length +
      segments.discussion.length +
      segments.statusUpdates.length

    if (
      totalItems === 0 &&
      shouldTreatEmptySegmentationAsFailure(transcripts, durationMinutes, fullText.length)
    ) {
      await this.markNoNotes(meetingId, EMPTY_SEGMENTATION_ERROR)
      return
    }

    await encryptJSON(segments, segmentsPath)
    await unlink(join(meetingDir, 'segments.error')).catch(() => {})

    console.log(
      `[perf] Segmentation total: ${((Date.now() - t0) / 1000).toFixed(1)}s (${meetingId})`
    )
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation completed',
      meetingId,
      context: {
        elapsedMs: Date.now() - t0,
        totalProcessingElapsedMs: Date.now() - jobStartedAt,
        itemCount: totalItems,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })

    this.activeStatus = 'complete'
    this.broadcastStatus(meetingId, 'complete')
    this.safeInvokeOnComplete(meetingId)
  }

  private safeInvokeOnComplete(meetingId: string): void {
    if (!this.onCompleteCallback) return

    try {
      this.onCompleteCallback(meetingId)
    } catch (err) {
      logAutodocFailure({
        area: 'segmentation',
        message: 'Segmentation completion callback failed',
        error: err,
        meetingId
      })
    }
  }

  private async logMacResourceSnapshot(message: string, meetingId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
    const hardware = await detectMacHardwareSnapshot()
    logAutodocEvent({
      area: 'segmentation',
      message,
      meetingId,
      context: {
        hardware,
        memoryHealthyForConcurrentProcessing: isMemoryHealthyForConcurrentProcessing(hardware),
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
  }

  private async markFailed(
    meetingId: string,
    error: Error | string,
    context?: SegmentationDirSnapshot
  ): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : error
    const errorCode = classifyError(errorMsg)
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    const existing = await this.readErrorFile(errorPath)
    const retries = (existing?.retries ?? 0) + 1
    try {
      await writeFile(
        errorPath,
        JSON.stringify({ error: errorMsg, errorCode, retries, status: 'failed' })
      )
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : null
      if (code !== 'ENOENT') throw err
    }
    logAutodocFailure({
      area: 'segmentation',
      message: 'Meeting notes generation failed',
      error,
      meetingId,
      context: {
        ...context,
        errorCode,
        retries,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
    this.broadcastStatus(meetingId, 'failed', undefined, errorCode)
  }

  private async markNoNotes(
    meetingId: string,
    errorMessage: string,
    context?: SegmentationDirSnapshot
  ): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    try {
      await writeFile(
        errorPath,
        JSON.stringify({ error: errorMessage, retries: 0, status: 'no-notes' })
      )
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : null
      if (code !== 'ENOENT') throw err
    }
    logAutodocFailure({
      area: 'segmentation',
      message: 'Meeting notes generation returned no structured output',
      error: errorMessage,
      meetingId,
      context: {
        ...context,
        processingProfile: this.getProcessingProfileLogContext()
      }
    })
    this.activeStatus = 'no-notes'
    this.broadcastStatus(meetingId, 'no-notes')
  }

  private async readErrorFile(errorPath: string): Promise<PersistedSegmentationError | null> {
    try {
      const raw = await readFile(errorPath, 'utf-8')
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedSegmentationError>
        return {
          error: typeof parsed.error === 'string' ? parsed.error : raw,
          retries: typeof parsed.retries === 'number' ? parsed.retries : 0,
          status: parsed.status,
          errorCode:
            typeof parsed.errorCode === 'string'
              ? parsed.errorCode
              : classifyError(typeof parsed.error === 'string' ? parsed.error : raw)
        }
      } catch {
        return { error: raw, retries: 0, errorCode: classifyError(raw) }
      }
    } catch {
      return null
    }
  }

  private getPersistedStatus(
    errorData: PersistedSegmentationError | null
  ): PersistedSegmentationStatus {
    if (errorData?.status === 'no-notes' || errorData?.error === EMPTY_SEGMENTATION_ERROR) {
      return 'no-notes'
    }

    return 'failed'
  }

  private getProcessingProfileLogContext(): Record<string, unknown> | null {
    const profile = this.getMacProcessingProfile?.()
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

  private broadcastStatus(
    meetingId: string,
    status: SegmentationStatus,
    progress?: number,
    errorCode?: string
  ): void {
    this.activeProgress = progress
    const windows = BrowserWindow.getAllWindows()
    const payload: SegmentationStatusPayload = { meetingId, status, progress, errorCode }
    for (const win of windows) {
      win.webContents.send('segmentation:status-changed', payload)
    }
  }

  private async captureDirSnapshot(meetingId: string): Promise<SegmentationDirSnapshot> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)
    const transcriptPath = join(meetingDir, 'transcript.json')
    const errorPath = join(meetingDir, 'segments.error')
    const [transcriptExists, segmentsExists, errorExists, existingError] = await Promise.all([
      this.fileExists(transcriptPath),
      this.fileExists(join(meetingDir, 'segments.json')),
      this.fileExists(errorPath),
      this.readErrorFile(errorPath)
    ])

    return {
      source: this.enqueueSource.get(meetingId) ?? 'unknown',
      files: {
        transcriptExists,
        transcriptEncrypted: transcriptExists && (await isEncrypted(transcriptPath)),
        segmentsExists,
        errorExists
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
