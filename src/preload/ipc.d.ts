import type { CalendarEvent } from '../shared/types'

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
}

export interface IpcInvokeReturns {
  'app:get-version': string
  'calendar:connect': void
  'calendar:disconnect': void
  'calendar:is-connected': boolean
  'calendar:get-events': CalendarEvent[]
  'calendar:sync': CalendarEvent[]
  'calendar:set-auto-record': void
}

export interface IpcOnEvents {
  'recording:status-changed': [status: string]
  'calendar:events-updated': [events: CalendarEvent[]]
}
