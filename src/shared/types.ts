import type { MemoryFailure } from './memory-failure'

export type MeetingStatus = 'recording' | 'processing' | 'complete' | 'failed'

export type SegmentCategory =
  | 'decision'
  | 'action_item'
  | 'information'
  | 'discussion'
  | 'status_update'

export interface Meeting {
  id: string
  title: string
  startTime: number
  endTime: number | null
  calendarEventId: string | null
  recordingPath: string | null
  audioPath: string | null
  status: MeetingStatus
  createdAt: number
}

export interface Transcript {
  id: string
  meetingId: string
  speaker: string
  text: string
  startMs: number
  endMs: number
  confidence: number
}

export interface Segment {
  id: string
  meetingId: string
  category: SegmentCategory
  topic: string | null
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
  /** Grounded writer title for Next Steps; kept out of summary ranking and ownership. */
  actionContext?: {
    title: string
    sourceStartMs: number
    sourceEndMs: number
  }
}

export type AutoRecordMode = 'off' | 'once' | 'series'

export interface CalendarAccount {
  id: string
  provider: 'google' | 'microsoft'
  email: string
  connectedAt: number
  syncIssue?: 'unsupported-mailbox' | 'reconnect-required' | null
}

export interface CalendarEvent {
  id: string // `{provider}_{externalId}` — unique across providers
  externalId: string // provider's native event ID
  accountId: string // which connected account owns this event
  provider: 'google' | 'microsoft' // source provider
  recurringEventId: string | null
  title: string
  startTime: number
  endTime: number
  isAllDay?: boolean
  attendees: string[]
  meetingUrl: string | null
  autoRecord: AutoRecordMode
  syncedAt: number
}

export interface MeetingSegments {
  decisions: Segment[]
  actionItems: Segment[]
  information: Segment[]
  discussion: Segment[]
  statusUpdates: Segment[]
}

export interface MeetingSegmentsWithCandidates extends MeetingSegments {
  /** Unaccepted Mac writer drafts; never include in canonical notes or summary ranking. */
  nextStepCandidates?: Segment[]
}

/** A canonical hash of a complete Notes V2 document. */
export type NotesRevision = `sha256:${string}`

/** A canonical hash of legacy `segments.json` content. */
export type LegacyNotesRevision = `legacy-sha256:${string}`

/** A canonical hash of the transcript from which a V2 document was generated. */
export type TranscriptRevision = `transcript-sha256:${string}`

/** A canonical hash of confirmed speaker labels used to generate a V2 document. */
export type NotesAttributionRevision = `notes-attribution-sha256:${string}`

/** Deterministic IDs used only inside the Notes V2 generation pipeline. */
export type NoteSourceId = `source:${string}`
export type NoteEvidenceId = `evidence:${string}`
export type NotesCacheSignature = `notes-cache-sha256:${string}`

export interface NoteSourceRange {
  startMs: number
  endMs: number
}

/**
 * `user-edited` means the retained ranges are original evidence, not proof of
 * the current user-authored wording. `legacy` is only produced by the adapter.
 */
export type PersistedNoteBlockProvenance = 'generated' | 'user-created' | 'user-edited'
export type NoteBlockProvenance = PersistedNoteBlockProvenance | 'legacy'

export interface NoteTextBlock<
  TProvenance extends NoteBlockProvenance = PersistedNoteBlockProvenance
> {
  text: string
  sources: NoteSourceRange[]
  provenance: TProvenance
}

export interface NoteItem<
  TProvenance extends NoteBlockProvenance = PersistedNoteBlockProvenance
> extends NoteTextBlock<TProvenance> {
  id: string
  title: string | null
  topic: string | null
  owner: string | null
  deadline: string | null
  /** Next-step checkbox. Optional on older documents; default false. */
  completed?: boolean
}

export interface NoteSection<
  TProvenance extends NoteBlockProvenance = PersistedNoteBlockProvenance,
  TItem extends NoteItem<TProvenance> = NoteItem<TProvenance>
> {
  id: string
  title: string
  summary: NoteTextBlock<TProvenance> | null
  keyPoints: TItem[]
  supportingDetails: TItem[]
}

export interface MeetingNotesContent<
  TProvenance extends NoteBlockProvenance = PersistedNoteBlockProvenance,
  TItem extends NoteItem<TProvenance> = NoteItem<TProvenance>
> {
  overview: NoteTextBlock<TProvenance> | null
  keyTakeaways: TItem[]
  sections: NoteSection<TProvenance, TItem>[]
  decisions: TItem[]
  nextSteps: TItem[]
}

export interface MeetingNotesV2 extends MeetingNotesContent {
  schemaVersion: 2
  meetingId: string
  /** Required for V2; a later transcript replacement makes its evidence stale. */
  sourceTranscriptRevision: TranscriptRevision
  /** Required for V2; a confirmed-speaker change makes attribution-bearing evidence stale. */
  sourceAttributionRevision: NotesAttributionRevision
  revision: NotesRevision
}

export interface LegacySegmentOrigin {
  adapterVersion: 1
  bucket: keyof MeetingSegments
  itemIndex: number
  segmentId: string | null
  meetingId: string | null
  category: SegmentCategory
  topic: string | null
  sourceStartMs: number
  sourceEndMs: number
}

export interface NormalizedNoteItem extends NoteItem<NoteBlockProvenance> {
  legacySource: LegacySegmentOrigin | null
}

interface NormalizedNotesBase extends MeetingNotesContent<NoteBlockProvenance, NormalizedNoteItem> {
  normalizedSchemaVersion: 1
  meetingId: string
}

/** Legacy notes cannot claim a V2 transcript binding, and V2 cannot carry a legacy revision. */
export type NormalizedNotes = NormalizedNotesBase &
  (
    | {
        source: { format: 'notes-v2'; schemaVersion: 2 }
        sourceTranscriptRevision: TranscriptRevision
        sourceAttributionRevision: NotesAttributionRevision
        revision: NotesRevision
      }
    | {
        source: { format: 'legacy-segments'; adapterVersion: 1 }
        sourceTranscriptRevision: null
        sourceAttributionRevision: null
        revision: LegacyNotesRevision
      }
  )

export type MeetingExportFormat = 'markdown' | 'pdf' | 'docx'

export interface MeetingExportRequest {
  meetingId: string
  format: MeetingExportFormat
}

export type MeetingExportFailureCode =
  | 'invalid-request'
  | 'nothing-to-export'
  | 'disk-full'
  | 'permission-denied'
  | 'render-failed'
  | 'write-failed'

export type MeetingExportResult =
  | { status: 'saved' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: MeetingExportFailureCode }

export interface MeetingCopyNotesRequest {
  meetingId: string
}

export type MeetingCopyNotesFailureCode = 'invalid-request' | 'nothing-to-copy' | 'copy-failed'

export type MeetingCopyNotesResult =
  | { status: 'copied' }
  | { status: 'failed'; code: MeetingCopyNotesFailureCode }

/** Stable, serializable address for any semantic block in a normalized note document. */
export type NoteBlockRef =
  | { kind: 'overview' }
  | { kind: 'section-summary'; sectionId: string }
  | { kind: 'item'; itemId: string }

export type NoteBlockLocation =
  | 'overview'
  | 'key-takeaway'
  | 'section-summary'
  | 'key-point'
  | 'supporting-detail'
  | 'decision'
  | 'next-step'

export type NoteEvidenceStatus = 'current' | 'stale' | 'unknown'

export interface NormalizedNoteBlock {
  ref: NoteBlockRef
  revision: NotesRevision | LegacyNotesRevision
  sourceTranscriptRevision: TranscriptRevision | null
  sourceAttributionRevision: NotesAttributionRevision | null
  evidenceStatus: NoteEvidenceStatus
  location: NoteBlockLocation
  /** The section containing this block, where applicable. */
  sectionId: string | null
  sectionTitle: string | null
  title: string | null
  topic: string | null
  text: string
  owner: string | null
  deadline: string | null
  sources: NoteSourceRange[]
  provenance: NoteBlockProvenance
  legacySource: LegacySegmentOrigin | null
}

export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  token_type?: string
  scope?: string
}

export type VideoStatus = 'processing' | 'ready' | 'failed'

export interface RecordingEntry {
  meetingId: string
  title: string
  date: number
  duration: number | null
  hasVideo: boolean
  hasAudio: boolean
  isFinalizing?: boolean
  videoStatus?: VideoStatus
  transcriptionStatus: TranscriptionStatus
}

export interface MeetingMetadata {
  sourceName: string | null
  startedAt: number
  stoppedAt: number
  durationSeconds: number
  isFinalizing?: boolean
  calendarTitle?: string
  customTitle?: string
  notesReadyNotificationSentAt?: number
  videoProcessingFailed?: boolean
  videoStatus?: VideoStatus
  videoCaptureEndedEarly?: boolean
}

export interface RecordingSource {
  id: string
  name: string
  thumbnailDataUrl: string
  iconDataUrl?: string
}

export type RecordingIntent = 'meeting' | 'general'

export interface RecordingTrackingContext {
  meetingSourceId: string | null
  meetingSourceName: string | null
  providerId: string | null
  recordingIntent: RecordingIntent
}

export interface RecordingState {
  isRecording: boolean
  meetingId: string | null
  startedAt: number | null
  sourceId: string | null
  sourceName: string | null
  recordingIntent?: RecordingIntent | null
  trackedMeetingSourceId?: string | null
  trackedMeetingSourceName?: string | null
  trackedMeetingProviderId?: string | null
}

export interface RecordingPaths {
  meetingId: string
  dir: string
  video: string
  audio: string
}

export type OpenSupportEmailResult =
  | { status: 'opened' }
  | { status: 'copy-required'; address: string }
  | { status: 'unavailable' }

export type SupportEmailSurface = 'sidebar' | 'onboarding' | 'upcoming' | 'ai_notes'

export type CopySupportEmailResult =
  | { status: 'copied' }
  | { status: 'copy-failed' }
  | { status: 'unavailable' }

export type FeedbackPromptSurface = Extract<SupportEmailSurface, 'upcoming' | 'ai_notes'>
export type FeedbackPromptAppearance = 'initial' | 'reminder'
export type FeedbackPromptAction = 'later' | 'dismiss' | 'never'

export type FeedbackPromptQAScenario = 'reset' | 'initial' | 'reminder' | 'contacted' | 'never'

export interface FeedbackPromptQASnapshot {
  stateAvailable: boolean
  eligible: boolean
  kind: FeedbackPromptAppearance | null
  reason: string
  windowForegrounded: boolean
  supportAvailable: boolean
  state: {
    qualifyingSessionCount: number
    qualifyingSessionDates: string[]
    lastQualifiedSessionAt: number | null
    initialPromptShownAt: number | null
    reminderPromptShownAt: number | null
    contactInitiatedAt: number | null
    neverAskAgain: boolean
  } | null
}

export type FeedbackPromptReservationResponse =
  | {
      status: 'reserved'
      reservationId: string
      appearance: FeedbackPromptAppearance
    }
  | { status: 'suppressed' }

export type FeedbackPromptConfirmationResponse = { status: 'confirmed' } | { status: 'rejected' }

/** Renderer reports `<video>` / `<audio>` `error` for main-process logging and Sentry. */
export interface RecordingMediaPlayerErrorReport {
  meetingId: string
  kind: 'video' | 'audio'
  mediaErrorCode: number | null
  mediaErrorMessage: string | null
  currentSrc: string
  networkState: number
  readyState: number
}

export interface TranscriptionStatusPayload {
  meetingId: string
  status: TranscriptionStatus
  progress?: number
  errorCode?: string
  memoryFailure?: MemoryFailure
  backendLabel?: string
  etaSeconds?: number | null
  recordingDurationSec?: number | null
  reprocessFailed?: boolean
}

export type TranscriptionStatus =
  | 'pending'
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'diarizing'
  | 'complete'
  | 'failed'

export interface SpeakerInfo {
  label: string
  suggestions?: string[]
}

export type SpeakerMap = Record<string, SpeakerInfo>

export interface SegmentationStatusPayload {
  meetingId: string
  status: SegmentationStatus
  progress?: number
  errorCode?: string
  memoryFailure?: MemoryFailure
  userReason?: string
  notesLayout?: 'v1' | 'v2'
  groupingFallback?: boolean
}

export type SegmentationActivity = 'waiting-for-local-ai'

export interface SegmentationActivityPayload {
  meetingId: string
  activity: SegmentationActivity | null
}

export interface SegmentationDiagnosticPayload {
  meetingId: string
  event:
    | 'ollama_low_memory_fallback_triggered'
    | 'ollama_low_memory_fallback_succeeded'
    | 'ollama_low_memory_fallback_failed'
  properties: Record<string, unknown>
}

export type SegmentationStatus =
  | 'pending'
  | 'queued'
  | 'downloading-model'
  | 'segmenting'
  | 'no-notes'
  | 'complete'
  | 'failed'

export interface OllamaSetupStatus {
  phase: 'starting' | 'downloading' | 'pulling' | 'ready' | 'error'
  percent: number
  /** Model name when phase is pulling (e.g. llama3.1 vs qwen3-embedding:0.6b). */
  pullModel?: string
  error?: string
  failedStep?: 'starting' | 'downloading' | 'pulling' | 'ready'
}

export interface WhisperSetupStatus {
  phase:
    | 'checking'
    | 'downloading-whisper'
    | 'downloading-ffmpeg'
    | 'downloading-model'
    | 'preparing-speaker-runtime'
    | 'installing-speaker-id'
    | 'downloading-speaker-model'
    | 'ready'
    | 'error'
  percent: number
  error?: string
  backend?:
    | 'mlx-whisper'
    | 'faster-whisper-cuda'
    | 'faster-whisper-cpu'
    | 'parakeet-gpu'
    | 'parakeet-cpu'
    | 'whisper-cpp'
  backendLabel?: string
  macProcessingProfileId?: 'mac-normal' | 'mac-low-spec'
  macProcessingProfileReason?: string
  windowsProcessingProfileId?: 'win-gpu' | 'win-cpu-normal' | 'win-low-spec'
  windowsProcessingProfileReason?: string
  notesModel?: string
  failedStep?:
    | 'downloading-whisper'
    | 'downloading-ffmpeg'
    | 'downloading-model'
    | 'preparing-speaker-runtime'
    | 'installing-speaker-id'
    | 'downloading-speaker-model'
    | 'ready'
}

export interface DiarizationSetupStatus {
  phase:
    | 'checking'
    | 'preparing-speaker-runtime'
    | 'installing-speaker-id'
    | 'downloading-speaker-model'
    | 'ready'
    | 'error'
  percent: number
  error?: string
  failedStep?:
    | 'preparing-speaker-runtime'
    | 'installing-speaker-id'
    | 'downloading-speaker-model'
    | 'ready'
}

export interface DetectionAutoRecordPayload {
  providerId: string | null
  hasCalendarEvent: boolean
}

export interface DetectionAutoStopPayload {
  reason: 'window_closed' | 'mic_idle' | 'provider_gone'
  sourceType: 'window' | 'screen'
  providerDetected: boolean
  meetingWindowVisible: boolean
  windowMissingPolls: number
  providerMissingPolls: number
  micSilentPolls: number
}

export interface DetectionAutoStopCancelledPayload extends DetectionAutoStopPayload {
  recoveredSignals: string[]
}

export interface AppRuntimeInfo {
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  officialBuild: boolean
  qaBuild: boolean
  buildChannel: 'development' | 'official' | 'custom' | 'qa'
  storagePath: string
  whisperModel: string
  transcriptionBackend?: string
  ollamaModel: string
  ramBucket?: '8gb' | '16gb' | '32gb+'
  cpuClass?: 'low' | 'recommended'
  hasGpu?: boolean
}

export type AnalyticsLocalSignal =
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'whisper_setup_completed'
  | 'ollama_setup_completed'
  | 'recording_completed'
  | 'notes_generated'
  | 'user_activated'

export interface AnalyticsState {
  installId: string
  firstLaunchDate: string
  lastDailyActiveDate: string | null
  sessionId: string | null
  sessionStartedAt: string | null
  onboardingStarted: boolean
  onboardingCompleted: boolean
  whisperSetupCompleted: boolean
  ollamaSetupCompleted: boolean
  setupCompleted: boolean
  firstRecordingCompleted: boolean
  firstNotesGenerated: boolean
  userActivated: boolean
  recordingsCompletedCount: number
  notesGeneratedCount: number
  firstSeenAppVersion: string | null
  lastSeenAppVersion: string | null
  pendingUpgradeFromVersion: string | null
  pendingUpgradeToVersion: string | null
}

export interface AnalyticsUpgradeTransition {
  previousVersion: string
  currentVersion: string
}

export interface AnalyticsConsentSnapshot {
  days_since_first_launch: number
  onboarding_started: boolean
  onboarding_completed: boolean
  setup_completed: boolean
  first_recording_completed: boolean
  first_notes_generated: boolean
  user_activated: boolean
  recordings_completed_bucket: string
  notes_generated_bucket: string
}

export interface AnalyticsDailyActiveResult {
  tracked: boolean
  daysSinceFirstLaunch: number
}

export interface AnalyticsSessionStartResult {
  sessionId: string
  daysSinceFirstLaunch: number
}

export interface AnalyticsSessionEndResult {
  sessionId: string
  sessionDurationBucket: string
}

export interface AppStorageInfo {
  storagePath: string
  downloadedComponentsBytes: number
  recordingsBytes: number
  logsBytes: number
  otherLocalDataBytes: number
  totalBytes: number
}
