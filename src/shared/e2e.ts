import type {
  CalendarAccount,
  CalendarEvent,
  OllamaSetupStatus,
  RecordingSource,
  WhisperSetupStatus,
} from './types'

export interface E2EScenario {
  permissions?: {
    microphone?: boolean
    screen?: boolean
  }
  whisper?: {
    status?: WhisperSetupStatus
    retryStatus?: WhisperSetupStatus
  }
  ollama?: {
    status?: OllamaSetupStatus
    retryStatus?: OllamaSetupStatus
  }
  calendar?: {
    accounts?: CalendarAccount[]
    events?: CalendarEvent[]
    connectSucceeds?: boolean
  }
  recording?: {
    sources?: RecordingSource[]
  }
}
