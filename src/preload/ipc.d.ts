import type {
  AutoRecordMode,
  CalendarAccount,
  CalendarEvent,
  RecordingEntry,
  RecordingSource,
  RecordingState,
  RecordingTrackingContext,
  RecordingPaths,
  RecordingMediaPlayerErrorReport,
  Transcript,
  TranscriptionStatus,
  MeetingSegments,
  SegmentationStatus,
  SpeakerMap,
  OllamaSetupStatus,
  WhisperSetupStatus,
  AppRuntimeInfo,
  AppStorageInfo,
  DetectionAutoRecordPayload,
  DetectionAutoStopPayload,
  DetectionAutoStopCancelledPayload,
  TranscriptionStatusPayload,
  SegmentationStatusPayload,
  SegmentationDiagnosticPayload
} from '../shared/types'
import type { E2EDetectionState, E2EPermissionRequestState } from '../shared/e2e'
import type { DiagnosticActionPayload } from '../shared/diagnostics'

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
  'app:get-runtime-info': []
  'app:get-storage-info': []
  'app:clear-downloaded-components': []
  'app:reset-local-data': []
  'diagnostics:record-action': [payload: DiagnosticActionPayload]
  'diagnostics:clear-trail': []
  'calendar:connect': [providerType: 'google' | 'microsoft']
  'calendar:disconnect': [accountId: string]
  'calendar:get-accounts': []
  'calendar:get-events': []
  'calendar:sync': []
  'calendar:set-auto-record': [
    eventId: string,
    recurringEventId: string | null,
    mode: AutoRecordMode
  ]
  'permissions:check': []
  'permissions:request-microphone-access': []
  'permissions:open-settings': [panel: 'screen' | 'microphone']
  'recording:list': []
  'recording:get-sources': []
  'recording:start': [
    sourceId: string,
    sourceName: string,
    trackingContext?: RecordingTrackingContext | null
  ]
  'recording:stop': []
  'recording:finalize-stop': [meetingId: string]
  'recording:get-state': []
  'recording:save-chunk': [
    meetingId: string,
    type: 'video' | 'mic' | 'system',
    chunk: ArrayBuffer,
    segmentIndex?: number
  ]
  'recording:save-segment-timing': [
    meetingId: string,
    type: 'video' | 'mic' | 'system',
    segmentIndex: number,
    offsetMs: number
  ]
  'recording:update-title': [meetingId: string, customTitle: string]
  'recording:delete': [meetingId: string]
  'transcription:get-status': [meetingId: string]
  'transcription:get-progress': [meetingId: string]
  'transcription:get-transcript': [meetingId: string]
  'transcription:retry': [meetingId: string]
  'ollama:check-status': []
  'ollama:get-model': []
  'segmentation:get-status': [meetingId: string]
  'segmentation:get-error-code': [meetingId: string]
  'segmentation:get-progress': [meetingId: string]
  'segmentation:get-segments': [meetingId: string]
  'segmentation:retry': [meetingId: string]
  'segmentation:save-segments': [meetingId: string, segments: MeetingSegments]
  'recording:get-media': [meetingId: string]
  'recording:report-media-player-error': [payload: RecordingMediaPlayerErrorReport]
  'recording:get-detail': [meetingId: string]
  'search:query': [query: string]
  'chat:send': [question: string]
  'detection:dismiss': []
  'speakers:get': [meetingId: string]
  'speakers:rename': [meetingId: string, speakerId: string, newLabel: string]
  'prefs:get-onboarding-complete': []
  'prefs:set-onboarding-complete': []
  'prefs:get-onboarding-step': []
  'prefs:set-onboarding-step': [step: number]
  'prefs:get-onboarding-permission-settings-opened': [panel: 'microphone' | 'screen']
  'prefs:set-onboarding-permission-settings-opened': [
    panel: 'microphone' | 'screen',
    opened: boolean
  ]
  'prefs:get-launch-at-login': []
  'prefs:set-launch-at-login': [enabled: boolean]
  'prefs:get-analytics-consent': []
  'prefs:set-analytics-consent': [enabled: boolean]
  'prefs:get-diagnostic-log-upload-consent': []
  'prefs:set-diagnostic-log-upload-consent': [enabled: boolean]
  'prefs:get-experimental-speaker-diarization': []
  'prefs:set-experimental-speaker-diarization': [enabled: boolean]
  'prefs:get-low-spec-mac-processing-banner-dismissed': []
  'prefs:set-low-spec-mac-processing-banner-dismissed': [dismissed: boolean]
  'ollama:get-setup-status': []
  'ollama:retry-setup': []
  'whisper:get-setup-status': []
  'whisper:retry-setup': []
  'e2e:set-whisper-status': [status: WhisperSetupStatus]
  'e2e:set-ollama-status': [status: OllamaSetupStatus]
  'e2e:get-detection-state': []
  'e2e:get-permission-request-state': []
  'e2e:set-detection-state': [state: Partial<E2EDetectionState>]
  'e2e:detection-poll': [advanceMs?: number]
  'e2e:trigger-main-error': []
  'e2e:trigger-notes-ready-notification': [
    options?: { meetingId?: string; title?: string; status?: 'complete' | 'failed' }
  ]
  'updater:get-status': []
  'updater:check': []
  'updater:install': []
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'app:get-runtime-info': AppRuntimeInfo
  'app:get-storage-info': AppStorageInfo
  'app:clear-downloaded-components': AppStorageInfo
  'app:reset-local-data': void
  'diagnostics:record-action': void
  'diagnostics:clear-trail': void
  'calendar:connect': CalendarAccount
  'calendar:disconnect': void
  'calendar:get-accounts': CalendarAccount[]
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
  'permissions:check': { screen: boolean; microphone: boolean }
  'permissions:request-microphone-access': boolean
  'permissions:open-settings': void
  'recording:list': RecordingEntry[]
  'recording:get-sources': RecordingSource[]
  'recording:start': RecordingPaths
  'recording:stop': { meetingId: string; startedAt: number; sourceName: string | null }
  'recording:finalize-stop': void
  'recording:get-state': RecordingState
  'recording:save-chunk': void
  'recording:save-segment-timing': void
  'recording:update-title': void
  'recording:delete': void
  'transcription:get-status': TranscriptionStatus
  'transcription:get-progress': number | undefined
  'transcription:get-transcript': Transcript[]
  'transcription:retry': void
  'ollama:check-status': boolean
  'ollama:get-model': string
  'segmentation:get-status': SegmentationStatus
  'segmentation:get-error-code': string | undefined
  'segmentation:get-progress': number | undefined
  'segmentation:get-segments': MeetingSegments | null
  'segmentation:retry': void
  'segmentation:save-segments': void
  'recording:get-media': {
    hasVideo: boolean
    hasAudio: boolean
    audioFile?: string
    mediaBaseUrl?: string
  }
  'recording:report-media-player-error': void
  'recording:get-detail': {
    title: string
    sourceName: string | null
    date: number
    durationSeconds: number | null
    isFinalizing?: boolean
  }
  'search:query': SearchResult[]
  'chat:send': string
  'detection:dismiss': void
  'speakers:get': SpeakerMap
  'speakers:rename': void
  'prefs:get-onboarding-complete': boolean
  'prefs:set-onboarding-complete': void
  'prefs:get-onboarding-step': number
  'prefs:set-onboarding-step': void
  'prefs:get-onboarding-permission-settings-opened': boolean
  'prefs:set-onboarding-permission-settings-opened': void
  'prefs:get-launch-at-login': boolean
  'prefs:set-launch-at-login': void
  'prefs:get-analytics-consent': boolean | null
  'prefs:set-analytics-consent': void
  'prefs:get-diagnostic-log-upload-consent': boolean
  'prefs:set-diagnostic-log-upload-consent': void
  'prefs:get-experimental-speaker-diarization': boolean
  'prefs:set-experimental-speaker-diarization': void
  'prefs:get-low-spec-mac-processing-banner-dismissed': boolean
  'prefs:set-low-spec-mac-processing-banner-dismissed': void
  'ollama:get-setup-status': OllamaSetupStatus
  'ollama:retry-setup': void
  'whisper:get-setup-status': WhisperSetupStatus
  'whisper:retry-setup': void
  'e2e:set-whisper-status': void
  'e2e:set-ollama-status': void
  'e2e:get-detection-state': E2EDetectionState
  'e2e:get-permission-request-state': E2EPermissionRequestState
  'e2e:set-detection-state': E2EDetectionState
  'e2e:detection-poll': void
  'e2e:trigger-main-error': void
  'e2e:trigger-notes-ready-notification': string
  'updater:get-status': UpdateStatus
  'updater:check': void
  'updater:install': void
}

export interface IpcOnEvents {
  'recording:status-changed': [state: RecordingState]
  'recording:entry-updated': [payload: { meetingId: string }]
  'calendar:events-updated': [events: CalendarEvent[]]
  'calendar:connection-changed': [connected: boolean]
  'transcription:status-changed': [payload: TranscriptionStatusPayload]
  'segmentation:status-changed': [payload: SegmentationStatusPayload]
  'segmentation:diagnostic-event': [payload: SegmentationDiagnosticPayload]
  'detection:meeting-detected': [payload: { title: string; body: string }]
  'detection:auto-record': [payload: DetectionAutoRecordPayload]
  'notes:open-meeting': [payload: { meetingId: string }]
  'detection:mic-inactive': [payload: Record<string, never>]
  'detection:auto-stop': [payload: DetectionAutoStopPayload]
  'detection:auto-stop-cancelled': [payload: DetectionAutoStopCancelledPayload]
  'ollama:setup-progress': [status: OllamaSetupStatus]
  'whisper:setup-progress': [status: WhisperSetupStatus]
  'updater:status': [status: UpdateStatus]
  'prefs:analytics-consent-changed': [enabled: boolean]
  'prefs:diagnostic-log-upload-consent-changed': [enabled: boolean]
  'prefs:experimental-speaker-diarization-changed': [enabled: boolean]
}
