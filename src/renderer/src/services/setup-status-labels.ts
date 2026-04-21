import type { OllamaSetupStatus, WhisperSetupStatus } from '../../../shared/types'

export function getWhisperSetupLabel(status: WhisperSetupStatus | null | undefined): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'checking':
      return 'Checking transcription engine...'
    case 'downloading-whisper':
      return `Downloading transcription engine... ${status.percent}%`
    case 'downloading-ffmpeg':
      return `Installing audio tools... ${status.percent}%`
    case 'downloading-model':
      return `Downloading speech model... ${status.percent}%`
    case 'preparing-speaker-runtime':
      return `Preparing speaker ID runtime... ${status.percent}%`
    case 'installing-speaker-id':
      return `Installing speaker ID... ${status.percent}%`
    case 'downloading-speaker-model':
      return `Downloading speaker model... ${status.percent}%`
    case 'error':
      return status.error ?? 'Transcription setup failed.'
    default:
      return null
  }
}

export function getOllamaSetupLabel(status: OllamaSetupStatus | null | undefined): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'starting':
      return 'Starting local AI engine...'
    case 'downloading':
      return `Downloading Ollama... ${status.percent}%`
    case 'pulling':
      return `Downloading AI model... ${status.percent}%`
    case 'error':
      return status.error ?? 'AI setup failed.'
    default:
      return null
  }
}
