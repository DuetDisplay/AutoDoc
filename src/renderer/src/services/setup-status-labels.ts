import type { OllamaSetupStatus, WhisperSetupStatus } from '../../../shared/types'
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  OLLAMA_ASK_AI_EMBEDDING_MODEL_LABEL,
  OLLAMA_NOTES_MODEL_LABEL,
  OLLAMA_RUNTIME_LABEL
} from '../../../shared/constants'

function getOllamaPullModelLabel(pullModel?: string): string {
  if (
    pullModel &&
    (pullModel === DEFAULT_OLLAMA_EMBEDDING_MODEL ||
      pullModel.startsWith(`${DEFAULT_OLLAMA_EMBEDDING_MODEL}:`) ||
      pullModel.toLowerCase().includes('embedding'))
  ) {
    return OLLAMA_ASK_AI_EMBEDDING_MODEL_LABEL
  }

  return OLLAMA_NOTES_MODEL_LABEL
}

export function getWhisperSetupLabel(status: WhisperSetupStatus | null | undefined): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'checking':
      return status.backendLabel
        ? `Checking ${status.backendLabel}...`
        : 'Checking transcription engine...'
    case 'downloading-whisper':
      return status.backendLabel
        ? `Downloading ${status.backendLabel}... ${status.percent}%`
        : `Downloading transcription engine... ${status.percent}%`
    case 'downloading-ffmpeg':
      return `Installing audio tools... ${status.percent}%`
    case 'downloading-model':
      return status.backendLabel
        ? `Downloading speech model for ${status.backendLabel}... ${status.percent}%`
        : `Downloading speech model... ${status.percent}%`
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
      return `Starting ${OLLAMA_RUNTIME_LABEL}...`
    case 'downloading':
      return `Downloading ${OLLAMA_RUNTIME_LABEL}... ${status.percent}%`
    case 'pulling': {
      const modelLabel = getOllamaPullModelLabel(status.pullModel)
      if (status.percent === 0) {
        return `Preparing ${modelLabel}...`
      }
      return `Downloading ${modelLabel}... ${status.percent}%`
    }
    case 'error':
      return status.error ?? 'AI setup failed.'
    default:
      return null
  }
}
