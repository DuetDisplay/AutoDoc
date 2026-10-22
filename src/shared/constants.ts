import type { SegmentCategory } from './types'

export const SEGMENT_LABELS: Record<SegmentCategory, string> = {
  decision: 'Decisions',
  action_item: 'Action Items',
  information: 'Information Shared',
  discussion: 'Discussion',
  status_update: 'Status Updates'
}

export const ROUTES = {
  upcoming: '/',
  recordings: '/recordings',
  meetingDetail: '/recordings/:id',
  search: '/search',
  askAi: '/ask-ai',
  settings: '/settings'
} as const

export const CALENDAR_SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export const GOOGLE_CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events.readonly']

export const MEETING_URL_PATTERNS = [
  /zoom\.us\/j/i,
  /teams\.microsoft\.com\/l\/meetup-join/i,
  /meet\.google\.com/i,
  /webex\.com\/meet/i
]

export const RECORDING_SUBDIR = 'recordings'
export const MODELS_SUBDIR = 'models'
export const PYTHON_ENV_SUBDIR = 'python-env'
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b-instruct'
export const LEGACY_OLLAMA_MODEL = 'llama3.1'
export const LOW_SPEC_MAC_OLLAMA_MODEL = 'llama3.2:3b'
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
export const OLLAMA_RUNTIME_LABEL = 'Ollama runtime'
export const OLLAMA_NOTES_MODEL_LABEL = 'notes model'
export const OLLAMA_ASK_AI_EMBEDDING_MODEL_LABEL = 'Ask AI search model'

/** Writer maps onto 0–this value so scan work is never shown as a frozen 99%. */
export const NOTES_WRITER_PROGRESS_END = 70
export const NOTES_SCAN_PROGRESS_END = 99

export const SPEAKER_COLORS: { border: string; bg: string }[] = [
  { border: 'var(--speaker-0-border)', bg: 'var(--speaker-0-bg)' },
  { border: 'var(--speaker-1-border)', bg: 'var(--speaker-1-bg)' },
  { border: 'var(--speaker-2-border)', bg: 'var(--speaker-2-bg)' },
  { border: 'var(--speaker-3-border)', bg: 'var(--speaker-3-bg)' },
  { border: 'var(--speaker-4-border)', bg: 'var(--speaker-4-bg)' },
  { border: 'var(--speaker-5-border)', bg: 'var(--speaker-5-bg)' },
  { border: 'var(--speaker-6-border)', bg: 'var(--speaker-6-bg)' },
  { border: 'var(--speaker-7-border)', bg: 'var(--speaker-7-bg)' }
]

export const MEETING_APP_PATTERNS = [
  { name: 'Zoom', pattern: /zoom/i },
  { name: 'Google Meet', pattern: /google meet|meet\.google\.com|^meet\s*[-–—]/i },
  { name: 'Microsoft Teams', pattern: /microsoft teams|teams\.microsoft/i },
  { name: 'Webex', pattern: /webex/i },
  { name: 'Slack', pattern: /slack/i }
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
  /^vivaldi/i
]

export const VIDEO_MIME_TYPE = 'video/webm;codecs=vp9'
export const AUDIO_MIME_TYPE = 'audio/webm;codecs=opus'
