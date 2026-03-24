import type { SegmentCategory } from './types'

export const SEGMENT_LABELS: Record<SegmentCategory, string> = {
  decision: 'Decisions',
  action_item: 'Action Items',
  information: 'Information Shared',
  discussion: 'Discussion',
  status_update: 'Status Updates',
}

export const ROUTES = {
  upcoming: '/',
  recordings: '/recordings',
  meetingDetail: '/recordings/:id',
  search: '/search',
  askAi: '/ask-ai',
  settings: '/settings',
} as const

export const CALENDAR_SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
]

export const MEETING_URL_PATTERNS = [
  /zoom\.us\/j/i,
  /teams\.microsoft\.com\/l\/meetup-join/i,
  /meet\.google\.com/i,
  /webex\.com\/meet/i,
]

export const RECORDING_DIR_NAME = 'AutoDoc'
export const RECORDING_SUBDIR = 'recordings'

export const MEETING_APP_PATTERNS = [
  { name: 'Zoom', pattern: /zoom/i },
  { name: 'Google Meet', pattern: /meet\.google\.com/i },
  { name: 'Microsoft Teams', pattern: /microsoft teams/i },
  { name: 'Webex', pattern: /webex/i },
  { name: 'Slack Huddle', pattern: /slack.*huddle|slack.*call/i },
]

export const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'
export const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus'
