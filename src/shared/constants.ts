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

export const RECORDING_SUBDIR = 'recordings'
export const MODELS_SUBDIR = 'models'
export const PYTHON_ENV_SUBDIR = 'python-env'
export const DEFAULT_OLLAMA_MODEL = 'llama3.1'
export const OLLAMA_RUNTIME_LABEL = 'Ollama runtime'
export const OLLAMA_NOTES_MODEL_LABEL = 'Llama 3.1 notes model'

export const SPEAKER_COLORS: { border: string; bg: string }[] = [
  { border: '#5B8C6A', bg: '#f6faf7' }, // Me — sage green
  { border: '#C4956A', bg: '#fdf8f4' }, // Speaker 1 — amber
  { border: '#7A8FB5', bg: '#f4f6fa' }, // Speaker 2 — slate blue
  { border: '#B57A8F', bg: '#faf4f6' }, // Speaker 3 — dusty rose
  { border: '#6A9E9E', bg: '#f4fafa' }, // Speaker 4 — teal
  { border: '#8F7AB5', bg: '#f6f4fa' }, // Speaker 5 — plum
  { border: '#A89460', bg: '#faf8f4' }, // Speaker 6 — ochre
  { border: '#7A8A7A', bg: '#f4f6f4' }, // Speaker 7 — slate
]

export const MEETING_APP_PATTERNS = [
  { name: 'Zoom', pattern: /zoom/i },
  { name: 'Google Meet', pattern: /google meet|meet\.google\.com|^meet\s*[-–—]/i },
  { name: 'Microsoft Teams', pattern: /microsoft teams|teams\.microsoft/i },
  { name: 'Webex', pattern: /webex/i },
  { name: 'Slack', pattern: /slack/i },
]

// Browser window names used as fallback when no meeting pattern matches
export const BROWSER_PATTERNS = [
  /^safari/i,
  /^google chrome/i,
  /^firefox/i,
  /^microsoft edge/i,
  /^brave/i,
  /^arc/i,
  /^opera/i,
  /^vivaldi/i,
]

export const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'
export const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus'
