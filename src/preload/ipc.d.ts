import type { CalendarEvent, RecordingEntry, RecordingSource, RecordingState, RecordingPaths, Transcript, TranscriptionStatus, MeetingSegments, SegmentationStatus } from '../shared/types'

export interface IpcSendEvents {
  'window:minimize': []
  'window:maximize': []
  'window:close': []
}

export interface IpcInvokeEvents {
  'app:get-version': []
  'calendar:connect': []
  'calendar:disconnect': []
  'calendar:is-connected': []
  'calendar:get-events': []
  'calendar:sync': []
  'calendar:set-auto-record': [eventId: string, autoRecord: boolean]
  'permissions:check': []
  'permissions:open-settings': [panel: 'screen' | 'microphone']
  'recording:list': []
  'recording:get-sources': []
  'recording:start': [sourceId: string, sourceName: string]
  'recording:stop': []
  'recording:get-state': []
  'recording:save-chunk': [meetingId: string, type: 'video' | 'audio', chunk: ArrayBuffer]
  'transcription:get-status': [meetingId: string]
  'transcription:get-transcript': [meetingId: string]
  'transcription:retry': [meetingId: string]
  'ollama:check-status': []
  'ollama:get-model': []
  'segmentation:get-status': [meetingId: string]
  'segmentation:get-segments': [meetingId: string]
  'segmentation:retry': [meetingId: string]
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'calendar:connect': void
  'calendar:disconnect': void
  'calendar:is-connected': boolean
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
  'permissions:check': { screen: boolean; microphone: boolean }
  'permissions:open-settings': void
  'recording:list': RecordingEntry[]
  'recording:get-sources': RecordingSource[]
  'recording:start': RecordingPaths
  'recording:stop': { meetingId: string; startedAt: number }
  'recording:get-state': RecordingState
  'recording:save-chunk': void
  'transcription:get-status': TranscriptionStatus
  'transcription:get-transcript': Transcript[]
  'transcription:retry': void
  'ollama:check-status': boolean
  'ollama:get-model': string
  'segmentation:get-status': SegmentationStatus
  'segmentation:get-segments': MeetingSegments | null
  'segmentation:retry': void
}

export interface IpcOnEvents {
  'recording:status-changed': [state: RecordingState]
  'calendar:events-updated': [events: CalendarEvent[]]
  'transcription:status-changed': [payload: { meetingId: string; status: TranscriptionStatus }]
  'segmentation:status-changed': [payload: { meetingId: string; status: SegmentationStatus }]
}
