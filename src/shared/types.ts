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
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
}

export type AutoRecordMode = 'off' | 'once' | 'series'

export interface CalendarEvent {
  id: string
  googleEventId: string
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
