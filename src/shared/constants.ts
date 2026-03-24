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
