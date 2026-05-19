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

export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  token_type?: string
  scope?: string
}

export interface RecordingEntry {
  meetingId: string
  title: string
  date: number
  duration: number | null
  hasVideo: boolean
  hasAudio: boolean
  isFinalizing?: boolean
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
}

export interface RecordingSource {
  id: string
  name: string
  thumbnailDataUrl: string
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
  backend?: 'faster-whisper-cuda' | 'faster-whisper-cpu' | 'whisper-cpp'
  backendLabel?: string
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
  platform: NodeJS.Platform
  storagePath: string
  whisperModel: string
  transcriptionBackend?: string
  ollamaModel: string
}

export interface AppStorageInfo {
  storagePath: string
  downloadedComponentsBytes: number
  recordingsBytes: number
  logsBytes: number
  otherLocalDataBytes: number
  totalBytes: number
}
