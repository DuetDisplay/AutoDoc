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
}

export interface CalendarEvent {
  id: string                          // `{provider}_{externalId}` — unique across providers
  externalId: string                  // provider's native event ID
  accountId: string                   // which connected account owns this event
  provider: 'google' | 'microsoft'   // source provider
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
  transcriptionStatus: TranscriptionStatus
}

export interface MeetingMetadata {
  sourceName: string | null
  startedAt: number
  stoppedAt: number
  durationSeconds: number
  customTitle?: string
}

export interface RecordingSource {
  id: string
  name: string
  thumbnailDataUrl: string
}

export interface RecordingState {
  isRecording: boolean
  meetingId: string | null
  startedAt: number | null
  sourceId: string | null
  sourceName: string | null
}

export interface RecordingPaths {
  meetingId: string
  dir: string
  video: string
  audio: string
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

export type SegmentationStatus =
  | 'pending'
  | 'queued'
  | 'downloading-model'
  | 'segmenting'
  | 'complete'
  | 'failed'

export interface OllamaSetupStatus {
  phase: 'starting' | 'downloading' | 'pulling' | 'ready' | 'error'
  percent: number
  error?: string
}

export interface WhisperSetupStatus {
  phase: 'downloading-whisper' | 'downloading-ffmpeg' | 'downloading-model' | 'ready' | 'error'
  percent: number
  error?: string
}

export interface AppRuntimeInfo {
  platform: NodeJS.Platform
  storagePath: string
  whisperModel: string
  ollamaModel: string
}
