import type {
  CalendarAccount,
  CalendarEvent,
  OllamaSetupStatus,
  RecordingSource,
  WhisperSetupStatus,
} from './types'

export interface E2EDetectionWindowSource {
  id: string
  name: string
}

export interface E2EDetectionState {
  providerActiveIds: string[]
  micActive: boolean | null
  windowSources: E2EDetectionWindowSource[]
}

export interface E2EScenario {
  platform?: 'darwin' | 'win32'
  permissions?: {
    microphone?: boolean
    screen?: boolean
  }
  whisper?: {
    status?: WhisperSetupStatus
    retryStatus?: WhisperSetupStatus
    retryStatuses?: WhisperSetupStatus[]
  }
  ollama?: {
    status?: OllamaSetupStatus
    retryStatus?: OllamaSetupStatus
    retryStatuses?: OllamaSetupStatus[]
  }
  calendar?: {
    accounts?: CalendarAccount[]
    events?: CalendarEvent[]
    connectSucceeds?: boolean
  }
  recording?: {
    sources?: RecordingSource[]
  }
  detection?: Partial<E2EDetectionState>
}
