import type { AutoRecordMode, CalendarAccount, CalendarEvent, RecordingEntry, RecordingSource, RecordingState, RecordingPaths, Transcript, TranscriptionStatus, MeetingSegments, SegmentationStatus, SpeakerMap, OllamaSetupStatus } from '../shared/types'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  error?: string
}

export interface SearchResult {
  meetingId: string
  title: string
  date: number
  matches: { type: 'transcript' | 'segment'; text: string; category?: string }[]
}

export interface IpcSendEvents {
  'window:minimize': []
  'window:maximize': []
  'window:close': []
}

export interface IpcInvokeEvents {
  'app:get-version': []
  'calendar:connect': [providerType: 'google' | 'microsoft']
  'calendar:disconnect': [accountId: string]
  'calendar:get-accounts': []
  'calendar:get-events': []
  'calendar:sync': []
  'calendar:set-auto-record': [eventId: string, recurringEventId: string | null, mode: AutoRecordMode]
  'permissions:check': []
  'permissions:open-settings': [panel: 'screen' | 'microphone']
  'recording:list': []
  'recording:get-sources': []
  'recording:start': [sourceId: string, sourceName: string]
  'recording:stop': []
  'recording:get-state': []
  'recording:save-chunk': [meetingId: string, type: 'video' | 'mic' | 'system', chunk: ArrayBuffer]
  'recording:delete': [meetingId: string]
  'transcription:get-status': [meetingId: string]
  'transcription:get-transcript': [meetingId: string]
  'transcription:retry': [meetingId: string]
  'ollama:check-status': []
  'ollama:get-model': []
  'segmentation:get-status': [meetingId: string]
  'segmentation:get-segments': [meetingId: string]
  'segmentation:retry': [meetingId: string]
  'segmentation:save-segments': [meetingId: string, segments: MeetingSegments]
  'recording:get-media': [meetingId: string]
  'recording:get-detail': [meetingId: string]
  'search:query': [query: string]
  'chat:send': [question: string]
  'detection:dismiss': []
  'speakers:get': [meetingId: string]
  'speakers:rename': [meetingId: string, speakerId: string, newLabel: string]
  'prefs:get-onboarding-complete': []
  'prefs:set-onboarding-complete': []
  'prefs:get-launch-at-login': []
  'prefs:set-launch-at-login': [enabled: boolean]
  'prefs:get-analytics-consent': []
  'prefs:set-analytics-consent': [enabled: boolean]
  'ollama:get-setup-status': []
  'ollama:retry-setup': []
  'updater:get-status': []
  'updater:check': []
  'updater:install': []
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'calendar:connect': CalendarAccount
  'calendar:disconnect': void
  'calendar:get-accounts': CalendarAccount[]
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
  'permissions:check': { screen: boolean; microphone: boolean }
  'permissions:open-settings': void
  'recording:list': RecordingEntry[]
  'recording:get-sources': RecordingSource[]
  'recording:start': RecordingPaths
  'recording:stop': { meetingId: string; startedAt: number; sourceName: string | null }
  'recording:get-state': RecordingState
  'recording:save-chunk': void
  'recording:delete': void
  'transcription:get-status': TranscriptionStatus
  'transcription:get-transcript': Transcript[]
  'transcription:retry': void
  'ollama:check-status': boolean
  'ollama:get-model': string
  'segmentation:get-status': SegmentationStatus
  'segmentation:get-segments': MeetingSegments | null
  'segmentation:retry': void
  'segmentation:save-segments': void
  'recording:get-media': { hasVideo: boolean; hasAudio: boolean; audioFile?: string }
  'recording:get-detail': { title: string; sourceName: string | null; date: number; durationSeconds: number | null }
  'search:query': SearchResult[]
  'chat:send': string
  'detection:dismiss': void
  'speakers:get': SpeakerMap
  'speakers:rename': void
  'prefs:get-onboarding-complete': boolean
  'prefs:set-onboarding-complete': void
  'prefs:get-launch-at-login': boolean
  'prefs:set-launch-at-login': void
  'prefs:get-analytics-consent': boolean | null
  'prefs:set-analytics-consent': void
  'ollama:get-setup-status': OllamaSetupStatus
  'ollama:retry-setup': void
  'updater:get-status': UpdateStatus
  'updater:check': void
  'updater:install': void
}

export interface IpcOnEvents {
  'recording:status-changed': [state: RecordingState]
  'calendar:events-updated': [events: CalendarEvent[]]
  'transcription:status-changed': [payload: { meetingId: string; status: TranscriptionStatus; progress?: number }]
  'segmentation:status-changed': [payload: { meetingId: string; status: SegmentationStatus; progress?: number }]
  'detection:meeting-detected': [payload: { title: string; body: string }]
  'detection:auto-record': [payload: Record<string, never>]
  'detection:mic-inactive': [payload: Record<string, never>]
  'detection:auto-stop': [payload: Record<string, never>]
  'ollama:setup-progress': [status: OllamaSetupStatus]
  'updater:status': [status: UpdateStatus]
}
