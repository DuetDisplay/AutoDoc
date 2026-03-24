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

export interface CalendarEvent {
  id: string
  googleEventId: string
  title: string
  startTime: number
  endTime: number
  attendees: string[]
  meetingUrl: string | null
  autoRecord: boolean
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
