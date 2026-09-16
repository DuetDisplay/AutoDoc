import { BrowserWindow } from 'electron'
import { access, lstat, readFile, writeFile, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { freemem, totalmem } from 'os'
import { LOW_SPEC_MAC_OLLAMA_MODEL } from '../../shared/constants'
import type {
  MeetingSegments,
  Transcript,
  SegmentationActivity,
  SegmentationActivityPayload,
  SegmentationStatus,
  SegmentationStatusPayload
} from '../../shared/types'
import type { LLMProvider } from './llm'
import {
  formatNotesWriterTranscript,
  getDevNotesModelOverride,
  isDevNotesSkipScanRewritesEnabled,
  shouldSkipWindowsTightScanRewrites
} from './llm'
import { encryptJSON, decryptJSON, isEncrypted } from './crypto'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { readMetadata } from './calendar-matcher'
import { logQaGateStopToNotes } from './qa-gate-log'
import { captureMessage } from './sentry-reporter'
import { classifyError } from './error-classification'
import { notesFailureKindFromCode, notesUserCopy } from '../../shared/notes-user-copy'
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
import { enqueueMeetingNotesWrite } from './meeting-notes-write-queue'
import { NotesRepository } from './notes-repository'
import {
  computeLegacyNotesRevision,
  computeNotesAttributionRevision,
  computeTranscriptRevision
} from './notes-revision'
import {
  runNotesScanPipeline,
  scanLayerProgress,
  type NotesRewritePolicy
} from './notes-scan-pipeline'
import type { OllamaAccelerator } from './ollama-accelerator'
import { getSystemMemorySnapshot } from './windows-transcription-runtime'
import { meetingSegmentsFromDisk, withoutNextStepCandidates } from './writer-catalog'
import type { WindowsProcessingProfile } from './windows-processing-profile'
import { isWindowsTopicWriterEnabled } from './windows-notes-experiment'
import { isMissingOllamaModelError, notesModelSetupError } from './notes-model-errors'

type EnqueueSource = 'direct' | 'recovery-scan'
type PersistedSegmentationStatus = Extract<SegmentationStatus, 'failed' | 'no-notes' | 'complete'>
interface OllamaReadiness {
  waitUntilReady(): Promise<void>
  isReadyForGeneration?(model?: string): Promise<boolean>
  prepareModelForGeneration?(preferredModel?: string): Promise<string>
  beginNotesGeneration?(): void
  endNotesGeneration?(): Promise<void>
  recoverUnhealthyRuntime?(): Promise<void>
  reapLeftoverRunners?(reason?: string, meetingId?: string): void
  recycleBloatedRunners?(reason?: string, meetingId?: string): void | Promise<boolean>
  getNotesAccelerator?(): OllamaAccelerator
}

/**
 * At ~5 tok/s a rejected restyle/compress costs minutes of compute that gets
 * thrown away, and the retry doubles it. On slow inference we allow one
 * attempt and stop rewriting entirely after two consecutive rejections.
 */
const CPU_CONSTRAINED_REWRITE_POLICY: NotesRewritePolicy = {
  maxAttemptsPerSection: 1,
  bailAfterConsecutiveRejects: 2
}

const SKIP_SCAN_REWRITE_POLICY: NotesRewritePolicy = {
  maxAttemptsPerSection: 1,
  bailAfterConsecutiveRejects: 0,
  skipRewrites: true
}

const WINDOWS_TIGHT_SCAN_POLICY: NotesRewritePolicy = {
  maxAttemptsPerSection: 1,
  bailAfterConsecutiveRejects: 0,
  skipRewrites: true,
  skipStructureLlm: true
}

/**
 * The model-free, exact-coverage presenter is on by default on both desktop
 * platforms; each keeps its own kill switch so QA can roll one platform back
 * without touching the other.
 */
export function shouldUseLosslessPresentation(
  platform: NodeJS.Platform = process.platform,
  flags: {
    disableMac?: string
    disableWindows?: string
  } = {
    disableMac: process.env.AUTODOC_DISABLE_MAC_LOSSLESS_NOTES,
    disableWindows: process.env.AUTODOC_DISABLE_WINDOWS_LOSSLESS_NOTES
  }
): boolean {
  if (platform === 'darwin') return flags.disableMac !== '1'
  if (platform === 'win32') return flags.disableWindows !== '1'
  return false
}

/**
 * Below this decode speed the scan's optional rewrite passes cost more time
 * than they are worth. Measured writer speed is the ground truth (a configured
 * GPU can still end up CPU-bound when the model does not fit its VRAM).
 */
const CONSTRAINED_REWRITE_MAX_TOK_PER_SEC = 12

function parseDevNotesScanPolicy(raw: string | undefined): 'cpu-constrained' | 'default' | null {
  const value = raw?.trim()
  if (value === 'cpu-constrained' || value === 'default') return value
  return null
}

const EMPTY_SEGMENTATION_ERROR =
  'LLM returned empty segments for non-trivial transcript — likely context overflow or model issue'
const OLLAMA_UNAVAILABLE_ERROR =
  'Ollama unavailable for notes generation — model runtime never became ready'
const OLLAMA_GENERATION_DEFER_MAX = 5
const OLLAMA_GENERATION_DEFER_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

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
  userReason?: string
  notesLayout?: 'v1' | 'v2'
  groupingFallback?: boolean
}

export class SegmentationService {
  private queue: string[] = []
  private activeJobId: string | null = null
  private activeJobSource: EnqueueSource | null = null
  private activeStatus: SegmentationStatus | null = null
  private activeProgress: number | undefined = undefined
  private activeActivity: SegmentationActivity | null = null
  private processing = false
  private enqueueSource = new Map<string, EnqueueSource>()
  private onCompleteCallback: ((meetingId: string) => void) | null = null
  private baselineLlmModel: string | null = null
  private lastAppliedMacModel: string | null = null
  private ollamaGenerationDeferCounts = new Map<string, number>()

  constructor(
    private llmProvider: LLMProvider,
    private ollamaManager: OllamaReadiness,
    private recordingsBaseDir: string,
    private localProcessingCoordinator: LocalProcessingCoordinator | null = null,
    private getMacProcessingProfile: (() => MacProcessingProfile | null) | null = null,
    private getEffectiveMacProcessingProfile:
      | (() => Promise<MacProcessingProfile | null>)
      | null = null,
    private getWindowsProcessingProfile: (() => WindowsProcessingProfile | null) | null = null,
    private getEffectiveWindowsProcessingProfile:
      | (() => Promise<WindowsProcessingProfile | null>)
      | null = null
  ) {}

  hasActiveOrQueuedWork(): boolean {
    return this.processing || this.activeJobId !== null || this.queue.length > 0
  }

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

  getActivity(meetingId: string): SegmentationActivity | null {
    if (this.activeJobId !== meetingId || this.activeStatus !== 'segmenting') {
      return null
    }
    return this.activeActivity
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

  async getUserReason(meetingId: string): Promise<string | undefined> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    const errorData = await this.readErrorFile(errorPath)
    return errorData?.userReason
  }

  async getSegments(meetingId: string): Promise<MeetingSegments | null> {
    const segmentsPath = join(this.recordingsBaseDir, meetingId, 'segments.json')
    try {
      if (await isEncrypted(segmentsPath)) {
        return meetingSegmentsFromDisk(await decryptJSON<unknown>(segmentsPath))
      }
      const data = await readFile(segmentsPath, 'utf-8')
      return meetingSegmentsFromDisk(JSON.parse(data))
    } catch {
      return null
    }
  }

  async saveSegments(meetingId: string, segments: MeetingSegments): Promise<void> {
    await this.persistSegments(meetingId, segments)
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
        if (this.ollamaGenerationDeferCounts.has(meetingId)) continue

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
          const isPermanentFailure =
            errorData?.errorCode === 'ollama-insufficient-memory' ||
            (process.platform === 'win32' && errorData?.errorCode === 'ollama-model-setup')
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
    this.activeActivity = null
    const dirSnapshot = await this.captureDirSnapshot(meetingId).catch(() => undefined)

    try {
      await this.processJob(meetingId)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.message !== 'SEGMENTATION_PREEMPTED') {
        await this.markFailed(meetingId, error, dirSnapshot)
      }
    } finally {
      this.updateActivity(meetingId, null)
      this.activeJobId = null
      this.activeJobSource = null
      this.activeStatus = null
      this.activeProgress = undefined
      this.activeActivity = null
      this.processing = false
      this.enqueueSource.delete(meetingId)
      this.processNext()
    }
  }

  private async processJob(meetingId: string): Promise<void> {
    if (process.platform !== 'win32') return this.processPreparedJob(meetingId)
    this.ollamaManager.beginNotesGeneration?.()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.processPreparedJob(meetingId)
        } catch (error) {
          if (!isMissingOllamaModelError(error)) throw error
          if (attempt > 0 || !this.ollamaManager.prepareModelForGeneration) {
            throw notesModelSetupError(error)
          }
          // Restart the whole job after a fresh preparation. Never mix models
          // across chunks, or use chunk retries to repair a missing download.
          logAutodocEvent({
            area: 'segmentation',
            message: 'notes generation retrying model preparation',
            meetingId,
            context: { model: this.llmProvider.getModel?.() }
          })
        }
      }
    } finally {
      // processJobExclusive has finished all requests and unloads by this point.
      await this.ollamaManager.endNotesGeneration?.()
    }
  }

  private async processPreparedJob(meetingId: string): Promise<void> {
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

    if (!(await this.fileExists(transcriptPath))) {
      return
    }

    const transcripts: Transcript[] = (await isEncrypted(transcriptPath))
      ? await decryptJSON<Transcript[]>(transcriptPath)
      : JSON.parse(await readFile(transcriptPath, 'utf-8'))

    if (!hasUsableTranscriptContent(transcripts)) {
      await this.persistSegments(
        meetingId,
        {
          decisions: [],
          actionItems: [],
          information: [],
          discussion: [],
          statusUpdates: []
        },
        { overwriteWhenV2Exists: true }
      )
      await unlink(join(meetingDir, 'segments.error')).catch(() => {})
      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete')
      this.safeInvokeOnComplete(meetingId)
      return
    }

    this.activeStatus = 'downloading-model'
    this.broadcastStatus(meetingId, 'downloading-model')
    this.reapNotesRunners('before-notes-profile', meetingId)
    const macProcessingProfile =
      (await this.getEffectiveMacProcessingProfile?.()) ?? this.getMacProcessingProfile?.()
    const windowsProcessingProfile =
      (await this.getEffectiveWindowsProcessingProfile?.()) ?? this.getWindowsProcessingProfile?.()
    const preferredModel =
      getDevNotesModelOverride() ??
      macProcessingProfile?.notesModel ??
      windowsProcessingProfile?.notesModel
    const preparesJobModel =
      process.platform === 'win32' && this.ollamaManager.prepareModelForGeneration != null
    if (macProcessingProfile) {
      const currentModel = this.llmProvider.getModel?.()
      if (currentModel && currentModel !== this.lastAppliedMacModel) {
        this.baselineLlmModel = currentModel
      }
      if (!preparesJobModel) {
        this.llmProvider.setModel?.(preferredModel!)
      }
      this.llmProvider.setLowMemoryMode?.(macProcessingProfile.id === 'mac-low-spec')
      this.lastAppliedMacModel = macProcessingProfile.notesModel
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes effective processing profile selected',
        meetingId,
        context: this.getProcessingProfileLogContext(macProcessingProfile) ?? undefined
      })
    } else if (windowsProcessingProfile) {
      const currentModel = this.llmProvider.getModel?.()
      if (currentModel && currentModel !== this.lastAppliedMacModel) {
        this.baselineLlmModel = currentModel
      }
      if (!preparesJobModel) {
        this.llmProvider.setModel?.(preferredModel!)
      }
      this.llmProvider.setLowMemoryMode?.(
        windowsProcessingProfile.id === 'win-low-spec' ||
          windowsProcessingProfile.notesModel === LOW_SPEC_MAC_OLLAMA_MODEL
      )
      this.lastAppliedMacModel = windowsProcessingProfile.notesModel
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes effective processing profile selected',
        meetingId,
        context: this.getWindowsProcessingProfileLogContext(windowsProcessingProfile) ?? undefined
      })
    } else {
      if (this.baselineLlmModel) {
        this.llmProvider.setModel?.(this.baselineLlmModel)
      }
      this.llmProvider.setLowMemoryMode?.(false)
      this.lastAppliedMacModel = null
    }
    const notesAccelerator = this.ollamaManager.getNotesAccelerator?.() ?? null
    if (notesAccelerator === 'vulkan') {
      this.llmProvider.setVramConstrainedContext?.(true, 'windows-vulkan')
    } else if (notesAccelerator === 'cpu') {
      this.llmProvider.setVramConstrainedContext?.(true, 'windows-cpu')
    } else {
      this.llmProvider.setVramConstrainedContext?.(false)
    }
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation waiting for model',
      meetingId,
      context: {
        transcriptCount: transcripts.length,
        processingProfile:
          this.getProcessingProfileLogContext(macProcessingProfile ?? undefined) ??
          (windowsProcessingProfile
            ? this.getWindowsProcessingProfileLogContext(windowsProcessingProfile)
            : null)
      }
    })
    const readyForGeneration = await this.ensureOllamaReadyForGeneration(meetingId, preferredModel)
    if (!readyForGeneration) {
      return
    }

    this.activeStatus = 'segmenting'
    if (process.platform === 'win32') {
      this.broadcastStatus(meetingId, 'segmenting')
    } else {
      this.broadcastStatus(meetingId, 'segmenting', 0)
    }

    const t0 = Date.now()
    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation started',
      meetingId,
      context: {
        transcriptCount: transcripts.length,
        waitForModelMs: t0 - jobStartedAt,
        processingProfile: this.getProcessingProfileLogContext(macProcessingProfile ?? undefined)
      }
    })

    const fullText = formatNotesWriterTranscript(transcripts)

    console.log(`[perf] Segmentation input: ${fullText.length} chars (${meetingId})`)

    // Compute actual duration from transcript timestamps
    const lastEntry = transcripts[transcripts.length - 1]
    const durationMinutes = lastEntry
      ? Math.round((lastEntry.endMs || lastEntry.startMs) / 60000)
      : undefined

    let lastBroadcastedPercent = -1
    const reportPercent = (percent: number): void => {
      if (percent === lastBroadcastedPercent) return
      lastBroadcastedPercent = percent
      this.broadcastStatus(meetingId, 'segmenting', percent)
    }
    let segments: MeetingSegments
    try {
      segments = await this.llmProvider.summarize(
        meetingId,
        fullText,
        reportPercent,
        durationMinutes,
        (activity) => {
          this.updateActivity(meetingId, activity)
        }
      )

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

      await this.persistSegments(meetingId, segments, { overwriteWhenV2Exists: true })
      if (this.llmProvider.completePrompt) {
        if (process.platform === 'win32') {
          await this.ollamaManager.recycleBloatedRunners?.('before-scan', meetingId)
        } else {
          this.reapNotesRunners('before-scan', meetingId)
        }
        await this.logNotesResourceSnapshot('notes runners reaped before scan', meetingId)
      }
      const scanOutcome = await this.persistScanLayerNotes(
        meetingId,
        segments,
        transcripts,
        (fraction, stage) => {
          const percent = scanLayerProgress(fraction)
          if (percent !== lastBroadcastedPercent) {
            console.log(`[perf] Notes scan ${stage}: ${percent}% (${meetingId})`)
          }
          reportPercent(percent)
        }
      )
      if (scanOutcome.notesLayout === 'v2') {
        await unlink(join(meetingDir, 'segments.error')).catch(() => {})
      }
      if (isWindowsTopicWriterEnabled() && scanOutcome.errorCode) {
        // A failed regeneration may leave an older V2 revision available.
        // Keep it, but never announce that revision as a successful new run.
        this.activeStatus = 'failed'
        this.broadcastStatus(meetingId, 'failed', undefined, scanOutcome.errorCode, {
          userReason: scanOutcome.userReason,
          notesLayout: scanOutcome.notesLayout
        })
        return
      }

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
          processingProfile: this.getProcessingProfileLogContext(),
          writerSkippedChunks: this.llmProvider.getLastWriterSkips?.() ?? []
        }
      })

      if (process.platform === 'win32') {
        const metadata = await readMetadata(meetingDir)
        if (metadata?.stoppedAt != null) {
          logQaGateStopToNotes(meetingId, {
            recordingDurationSec: metadata.durationSeconds,
            stopToNotesWallSec: (Date.now() - metadata.stoppedAt) / 1000,
            transcriptionToNotesWallSec: (Date.now() - jobStartedAt) / 1000,
            notesItemCount: totalItems
          })
        }
      }

      this.activeStatus = 'complete'
      this.broadcastStatus(meetingId, 'complete', undefined, scanOutcome.errorCode, {
        userReason: scanOutcome.userReason,
        notesLayout: scanOutcome.notesLayout,
        groupingFallback: scanOutcome.groupingFallback
      })
      this.safeInvokeOnComplete(meetingId)
    } finally {
      if (process.platform === 'darwin' || process.platform === 'win32') {
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
        this.reapNotesRunners('after-notes', meetingId)
        await this.logNotesResourceSnapshot('notes resources released', meetingId)
      }
    }
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

  private async persistScanLayerNotes(
    meetingId: string,
    segments: MeetingSegments,
    transcripts: Transcript[],
    onProgress?: (fraction: number, stage: string) => void
  ): Promise<{
    notesLayout: 'v1' | 'v2'
    errorCode?: string
    userReason?: string
    groupingFallback?: boolean
  }> {
    const presentationMode = shouldUseLosslessPresentation() ? 'lossless' : undefined
    if (!this.llmProvider.completePrompt && !presentationMode) {
      return { notesLayout: 'v1' }
    }

    const startedAt = Date.now()
    try {
      const meetingDir = join(this.recordingsBaseDir, meetingId)
      const metadata = await readMetadata(meetingDir)
      const title =
        metadata?.customTitle || metadata?.calendarTitle || metadata?.sourceName || 'Notes'
      let loggedScanRequest = false
      const notesAccelerator = this.ollamaManager.getNotesAccelerator?.() ?? null
      const lastEvalTokPerSec = this.llmProvider.getLastEvalTokPerSec?.() ?? null
      const measuredTokPerSec =
        this.llmProvider.getWriterWeightedEvalTokPerSec?.() ?? lastEvalTokPerSec
      const forcedScanPolicy = parseDevNotesScanPolicy(process.env.AUTODOC_TEST_NOTES_SCAN_POLICY)
      const constrained =
        forcedScanPolicy === 'cpu-constrained'
          ? true
          : forcedScanPolicy === 'default'
            ? false
            : measuredTokPerSec != null
              ? measuredTokPerSec < CONSTRAINED_REWRITE_MAX_TOK_PER_SEC
              : notesAccelerator === 'cpu'
      const rewritePolicy = shouldSkipWindowsTightScanRewrites()
        ? WINDOWS_TIGHT_SCAN_POLICY
        : isDevNotesSkipScanRewritesEnabled()
          ? SKIP_SCAN_REWRITE_POLICY
          : constrained
            ? CPU_CONSTRAINED_REWRITE_POLICY
            : undefined
      let missingModelError: unknown
      const result = await runNotesScanPipeline(segments, {
        embed: this.llmProvider.embedNotes ? texts => this.llmProvider.embedNotes!(texts) : undefined,
        title,
        meetingId,
        presentationMode,
        attributionTranscript: presentationMode ? transcripts : undefined,
        localOwnerLabel: presentationMode ? 'Me' : undefined,
        rewritePolicy,
        spanSources: transcripts.map((row) => ({ startMs: row.startMs, endMs: row.endMs })),
        transcript: transcripts.map((row) => ({
          speaker: row.speaker,
          text: row.text,
          startMs: row.startMs,
          endMs: row.endMs
        })),
        generate: (request) => {
          if (missingModelError) return Promise.reject(missingModelError)
          if (!loggedScanRequest) {
            loggedScanRequest = true
            logAutodocEvent({
              area: 'segmentation',
              message: 'notes scan first ollama request',
              meetingId,
              context: {
                num_ctx: request.num_ctx,
                num_predict: request.num_predict
              }
            })
          }
          const result = this.llmProvider.completePrompt!(request.prompt, {
            num_ctx: request.num_ctx,
            num_predict: request.num_predict,
            temperature: request.temperature,
            seed: request.seed,
            stop: request.stop,
            format: request.format
          })
          if (process.platform !== 'win32') return result
          return result.catch((error) => {
            if (isMissingOllamaModelError(error)) missingModelError = error
            throw error
          })
        },
        onProgress: (update) => onProgress?.(update.fraction, update.stage)
      })
      // Optional scan passes may catch generation errors. A missing model must
      // still return to the job's bounded preparation/retry path.
      if (missingModelError) throw missingModelError
      const meetingNotesPath = join(meetingDir, 'notes.json')
      await enqueueMeetingNotesWrite(this.recordingsBaseDir, meetingId, async () => {
        try {
          await unlink(meetingNotesPath)
        } catch (error) {
          if (!isNodeErrorWithCode(error, 'ENOENT')) throw error
        }
      })
      const repository = new NotesRepository(this.recordingsBaseDir)
      await repository.promoteLegacyToV2(meetingId, result.content, {
        expectedLegacyRevision: computeLegacyNotesRevision(meetingId, withoutNextStepCandidates(segments)),
        sourceTranscriptRevision: computeTranscriptRevision(meetingId, transcripts),
        sourceAttributionRevision: computeNotesAttributionRevision(meetingId, transcripts)
      })
      const writerItemCount = [segments.decisions, segments.actionItems, segments.information,
        segments.discussion, segments.statusUpdates].reduce(
        (total, bucket) => total + bucket.length,
        0
      )
      const presentedItemCount =
        result.content.keyTakeaways.length +
        result.content.decisions.length +
        result.content.nextSteps.length +
        result.content.sections.reduce(
          (total, section) => total + section.keyPoints.length + section.supportingDetails.length,
          0
        )
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes scan layer completed',
        meetingId,
        context: {
          elapsedMs: Date.now() - startedAt,
          groupingFallback: result.groupingFallback,
          restyleFallbacks: result.restyleFallbacks,
          compressFallbacks: result.compressFallbacks,
          restyleSkips: result.restyleSkips,
          compressSkips: result.compressSkips,
          rewritePolicy: rewritePolicy?.skipStructureLlm
            ? 'skip-structure'
            : rewritePolicy?.skipRewrites
              ? 'skip-rewrites'
              : rewritePolicy
                ? 'cpu-constrained'
                : 'default',
          notesAccelerator,
          measuredTokPerSec,
          lastEvalTokPerSec,
          forcedScanPolicy,
          presentationMode: result.presentationMode ?? presentationMode ?? 'scan',
          exactWriterCoverage: result.exactWriterCoverage ?? false,
          organizationAttempted: result.organizationAttempted,
          organizationAccepted: result.organizationAccepted,
          organizationOverviewAccepted: result.organizationOverviewAccepted,
          attributionOwnersAdded: result.attributionOwnersAdded ?? 0,
          attributionOwnersStripped: result.attributionOwnersStripped ?? 0,
          attributionOwnersPreserved: result.attributionOwnersPreserved ?? 0,
          attributionOwnersChanged: result.attributionOwnersChanged ?? 0,
          recoveredActionCount: result.recoveredActionCount ?? 0,
          contextualizedNextStepCount: result.contextualizedNextStepCount ?? 0,
          promotedActionCount: result.promotedActionCount ?? 0,
          dedupedRecoveredActionCount: result.dedupedRecoveredActionCount ?? 0,
          recoveredDecisionCount: result.recoveredDecisionCount ?? 0,
          promotedDecisionCount: result.promotedDecisionCount ?? 0,
          dedupedRecoveredDecisionCount: result.dedupedRecoveredDecisionCount ?? 0,
          restyleRejectReasons: result.restyleRejectReasons,
          compressRejectReasons: result.compressRejectReasons,
          attachFailed: result.attachFailed,
          overviewFailed: result.overviewFailed,
          overviewSkipped: result.overviewSkipped ?? false,
          validationRan: result.validation.ran,
          validationError: result.validation.error,
          ledgerChunksFailed: result.validation.ledgerChunksFailed,
          claimsChecked: result.validation.claimsChecked,
          claimsDropped: result.validation.claimsDropped,
          ownersStripped: result.validation.ownersStripped,
          ledgerAppends: result.validation.ledgerAppends,
          unvalidatedClaims: result.validation.unvalidatedClaims,
          writerItemCount,
          presentedItemCount,
          topicCoveragePercent: result.topicCoveragePercent,
          genericHeadingPercent: result.genericHeadingPercent,
          needsReviewCount: result.needsReviewCount,
          contextDependentRejected: result.contextDependentRejected,
          sectionCount: result.content.sections.length,
          decisionCount: result.content.decisions.length,
          nextStepCount: result.content.nextSteps.length,
          notesLayout: 'v2'
        }
      })
      if (result.groupingFallback) {
        logAutodocEvent({
          area: 'segmentation',
          level: 'warn',
          message: 'notes grouping fallback',
          meetingId
        })
      }
      if (result.attachFailed) {
        logAutodocEvent({
          area: 'segmentation',
          level: 'warn',
          message: 'notes attach timestamps failed',
          meetingId
        })
      }
      if (result.overviewFailed) {
        logAutodocEvent({
          area: 'segmentation',
          level: 'warn',
          message: 'notes overview pass failed',
          meetingId,
          context: { reasons: result.overviewFailureReasons }
        })
      }
      return { notesLayout: 'v2', groupingFallback: result.groupingFallback }
    } catch (error) {
      if (process.platform === 'win32' && isMissingOllamaModelError(error)) throw error
      const copy = notesUserCopy('layout')
      logAutodocFailure({
        area: 'segmentation',
        message: 'notes scan layer failed; keeping legacy segments',
        error,
        meetingId,
        context: {
          elapsedMs: Date.now() - startedAt,
          notesLayout: 'v1',
          errorCode: 'scan_or_persist'
        }
      })
      captureMessage('notes_layout_degraded', {
        area: 'segmentation',
        meetingId,
        level: 'warning',
        tags: { errorCode: 'scan_or_persist', notes_layout: 'v1' },
        extra: { elapsedMs: Date.now() - startedAt }
      })
      await this.writeOutcomeFile(meetingId, {
        error: error instanceof Error ? error.message : String(error),
        retries: 0,
        status: isWindowsTopicWriterEnabled() ? 'failed' : 'complete',
        errorCode: 'scan_or_persist',
        userReason: `${copy.title}. ${copy.body}`,
        notesLayout: 'v1'
      })
      return {
        notesLayout: 'v1',
        errorCode: 'scan_or_persist',
        userReason: `${copy.title}. ${copy.body}`
      }
    }
  }

  private persistSegments(
    meetingId: string,
    segments: MeetingSegments,
    options?: { overwriteWhenV2Exists?: boolean }
  ): Promise<void> {
    return enqueueMeetingNotesWrite(this.recordingsBaseDir, meetingId, async () => {
      const meetingDir = join(this.recordingsBaseDir, meetingId)
      if (!options?.overwriteWhenV2Exists) {
        try {
          await lstat(join(meetingDir, 'notes.json'))
          return
        } catch (error) {
          if (!isNodeErrorWithCode(error, 'ENOENT')) {
            throw new Error('Could not inspect authoritative meeting notes')
          }
        }
      }
      await encryptJSON(withoutNextStepCandidates(segments), join(meetingDir, 'segments.json'))
    })
  }

  private async ensureOllamaReadyForGeneration(
    meetingId: string,
    preferredModel?: string
  ): Promise<boolean> {
    // macOS/Linux keep shared startup readiness and the original error behavior.
    if (process.platform !== 'win32') {
      await this.ollamaManager.waitUntilReady()
    } else {
      try {
        await this.ollamaManager.waitUntilReady()
        if (this.ollamaManager.prepareModelForGeneration) {
          const activeModel = await this.ollamaManager.prepareModelForGeneration(preferredModel)
          this.llmProvider.setModel?.(activeModel)
          if (activeModel === LOW_SPEC_MAC_OLLAMA_MODEL) this.llmProvider.setLowMemoryMode?.(true)
          logAutodocEvent({
            area: 'segmentation',
            message: 'notes job model selected',
            meetingId,
            context: { preferredModel, activeModel }
          })
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'OLLAMA_START_CANCELLED') {
          throw error
        }
        throw notesModelSetupError(error)
      }
    }

    if (!this.ollamaManager.isReadyForGeneration) {
      return true
    }

    const isReady = (): Promise<boolean> =>
      process.platform === 'win32'
        ? this.ollamaManager.isReadyForGeneration!(this.llmProvider.getModel?.())
        : this.ollamaManager.isReadyForGeneration!()
    if (await isReady()) {
      this.ollamaGenerationDeferCounts.delete(meetingId)
      return true
    }

    const deferCount = this.ollamaGenerationDeferCounts.get(meetingId) ?? 0
    if (deferCount === 0 && this.ollamaManager.recoverUnhealthyRuntime) {
      logAutodocEvent({
        area: 'segmentation',
        message: 'notes generation recovering unhealthy Ollama runtime',
        meetingId
      })
      await this.ollamaManager.recoverUnhealthyRuntime()
      if (await isReady()) {
        this.ollamaGenerationDeferCounts.delete(meetingId)
        return true
      }
    }
    if (deferCount >= OLLAMA_GENERATION_DEFER_MAX) {
      this.ollamaGenerationDeferCounts.delete(meetingId)
      throw new Error(OLLAMA_UNAVAILABLE_ERROR)
    }

    this.ollamaGenerationDeferCounts.set(meetingId, deferCount + 1)
    const source = this.enqueueSource.get(meetingId) ?? 'direct'
    const delayMs = OLLAMA_GENERATION_DEFER_DELAYS_MS[deferCount] ?? 30_000

    logAutodocEvent({
      area: 'segmentation',
      message: 'notes generation deferred waiting for Ollama readiness',
      meetingId,
      context: {
        deferCount: deferCount + 1,
        deferDelayMs: delayMs,
        source
      }
    })

    setTimeout(() => {
      this.enqueue(meetingId, source)
    }, delayMs)

    return false
  }

  private reapNotesRunners(reason: string, meetingId: string): void {
    this.ollamaManager.reapLeftoverRunners?.(reason, meetingId)
  }

  private async logNotesResourceSnapshot(message: string, meetingId: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return
    if (process.platform === 'darwin') {
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
      return
    }

    if (process.platform !== 'win32') return

    const memory = getSystemMemorySnapshot()
    const gib = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 100) / 100
    logAutodocEvent({
      area: 'segmentation',
      message,
      meetingId,
      context: {
        freeMemoryGiB: memory.freeMemoryGiB ?? gib(freemem()),
        totalMemoryGiB: memory.totalMemoryGiB ?? gib(totalmem()),
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
      const copy = notesUserCopy(notesFailureKindFromCode(errorCode))
      await writeFile(
        errorPath,
        JSON.stringify({
          error: errorMsg,
          errorCode,
          retries,
          status: 'failed',
          userReason: `${copy.title}. ${copy.body}`,
          notesLayout: 'v1'
        })
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
        JSON.stringify({
          error: errorMessage,
          retries: 0,
          status: 'no-notes',
          errorCode: 'no_notes_detected',
          userReason: `${notesUserCopy('empty').title}. ${notesUserCopy('empty').body}`
        })
      )
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : null
      if (code !== 'ENOENT') throw err
    }
    const copy = notesUserCopy('empty')
    logAutodocEvent({
      area: 'segmentation',
      level: 'warn',
      message: 'Meeting notes generation returned no structured output',
      meetingId,
      context: {
        ...context,
        errorCode: 'no_notes_detected',
        userReason: `${copy.title}. ${copy.body}`,
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
              : classifyError(typeof parsed.error === 'string' ? parsed.error : raw),
          userReason: typeof parsed.userReason === 'string' ? parsed.userReason : undefined,
          notesLayout:
            parsed.notesLayout === 'v2' || parsed.notesLayout === 'v1'
              ? parsed.notesLayout
              : undefined,
          groupingFallback:
            typeof parsed.groupingFallback === 'boolean' ? parsed.groupingFallback : undefined
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
    if (errorData?.status === 'complete') {
      return 'complete'
    }
    if (errorData?.status === 'no-notes' || errorData?.error === EMPTY_SEGMENTATION_ERROR) {
      return 'no-notes'
    }

    return 'failed'
  }

  private async writeOutcomeFile(
    meetingId: string,
    outcome: PersistedSegmentationError
  ): Promise<void> {
    const errorPath = join(this.recordingsBaseDir, meetingId, 'segments.error')
    try {
      await writeFile(errorPath, JSON.stringify(outcome))
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: string }).code)
          : null
      if (code !== 'ENOENT') throw err
    }
  }

  private getProcessingProfileLogContext(
    selectedProfile?: MacProcessingProfile
  ): Record<string, unknown> | null {
    const profile = selectedProfile ?? this.getMacProcessingProfile?.()
    if (!profile) {
      return this.getWindowsProcessingProfileLogContext()
    }

    return {
      profileId: profile.id,
      reason: profile.reason,
      hardware: profile.hardware,
      settings: {
        transcriptionBackend: profile.transcriptionBackend,
        transcriptionModel: profile.transcriptionModel,
        notesModel: profile.notesModel,
        dualSourceMode: profile.dualSourceMode,
        notesAfterTranscriptionOnly: profile.notesAfterTranscriptionOnly,
        serializeLocalProcessing: profile.serializeLocalProcessing
      }
    }
  }

  private getWindowsProcessingProfileLogContext(
    selectedProfile?: WindowsProcessingProfile
  ): Record<string, unknown> | null {
    const profile = selectedProfile ?? this.getWindowsProcessingProfile?.()
    if (!profile) {
      return null
    }

    return {
      profileId: profile.id,
      reason: profile.reason,
      hardware: profile.hardware,
      settings: {
        notesModel: profile.notesModel,
        dualSourceMode: profile.dualSourceMode,
        notesAfterTranscriptionOnly: profile.notesAfterTranscriptionOnly,
        serializeLocalProcessing: profile.serializeLocalProcessing,
        threadPolicy: profile.threadPolicy
      }
    }
  }

  private broadcastStatus(
    meetingId: string,
    status: SegmentationStatus,
    progress?: number,
    errorCode?: string,
    extras?: {
      userReason?: string
      notesLayout?: 'v1' | 'v2'
      groupingFallback?: boolean
    }
  ): void {
    if (status !== 'segmenting' && this.activeJobId === meetingId) {
      this.updateActivity(meetingId, null)
    }
    if (
      status === 'segmenting' &&
      typeof progress === 'number' &&
      typeof this.activeProgress === 'number'
    ) {
      progress = Math.max(progress, this.activeProgress)
    }
    this.activeProgress = progress
    const windows = BrowserWindow.getAllWindows()
    const payload: SegmentationStatusPayload = {
      meetingId,
      status,
      progress,
      errorCode,
      userReason: extras?.userReason,
      notesLayout: extras?.notesLayout,
      groupingFallback: extras?.groupingFallback
    }
    for (const win of windows) {
      win.webContents.send('segmentation:status-changed', payload)
    }
  }

  private updateActivity(meetingId: string, activity: SegmentationActivity | null): void {
    if (this.activeJobId !== meetingId) return
    if (activity !== null && this.activeStatus !== 'segmenting') return
    if (this.activeActivity === activity) return

    this.activeActivity = activity
    const payload: SegmentationActivityPayload = { meetingId, activity }

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('segmentation:activity-changed', payload)
        } catch (error) {
          console.warn('Failed to send segmentation activity update:', error)
        }
      }
    } catch (error) {
      console.warn('Failed to enumerate windows for segmentation activity update:', error)
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
