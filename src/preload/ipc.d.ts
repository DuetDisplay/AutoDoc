import type { CalendarEvent, RecordingSource, RecordingState, RecordingPaths } from '../shared/types'

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
  'recording:get-sources': []
  'recording:start': [sourceId: string, sourceName: string]
  'recording:stop': []
  'recording:get-state': []
  'recording:save-chunk': [meetingId: string, type: 'video' | 'audio', chunk: ArrayBuffer]
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'calendar:connect': void
  'calendar:disconnect': void
  'calendar:is-connected': boolean
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
  'recording:get-sources': RecordingSource[]
  'recording:start': RecordingPaths
  'recording:stop': { meetingId: string; startedAt: number }
  'recording:get-state': RecordingState
  'recording:save-chunk': void
}

export interface IpcOnEvents {
  'recording:status-changed': [state: RecordingState]
  'calendar:events-updated': [events: CalendarEvent[]]
}
