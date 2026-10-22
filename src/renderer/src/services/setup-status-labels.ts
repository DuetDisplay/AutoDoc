import { translate, type MessageKey } from '../../../shared/i18n'
import { DEFAULT_UI_LANGUAGE } from '../../../shared/ui-language'
import type { OllamaSetupStatus, WhisperSetupStatus } from '../../../shared/types'

type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string

const defaultT: TranslateFn = (key, params) => translate(DEFAULT_UI_LANGUAGE, key, params)
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

export function getWhisperSetupLabel(
  status: WhisperSetupStatus | null | undefined,
  t: TranslateFn = defaultT
): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'checking':
      return status.backendLabel
        ? t('setup.checkingBackend', { backend: status.backendLabel })
        : t('setup.checkingEngine')
    case 'downloading-whisper':
      return status.backendLabel
        ? t('setup.downloadingBackend', { backend: status.backendLabel, percent: status.percent })
        : t('setup.downloadingEngine', { percent: status.percent })
    case 'downloading-ffmpeg':
      return t('setup.installingAudioTools', { percent: status.percent })
    case 'downloading-model':
      return status.backendLabel
        ? t('setup.downloadingSpeechModelBackend', {
            backend: status.backendLabel,
            percent: status.percent
          })
        : t('setup.downloadingSpeechModel', { percent: status.percent })
    case 'preparing-speaker-runtime':
      return t('setup.preparingSpeakerRuntime', { percent: status.percent })
    case 'installing-speaker-id':
      return t('setup.installingSpeakerId', { percent: status.percent })
    case 'downloading-speaker-model':
      return t('setup.downloadingSpeakerModel', { percent: status.percent })
    case 'error':
      return status.error ?? t('setup.transcriptionFailed')
    default:
      return null
  }
}

export function getOllamaSetupLabel(
  status: OllamaSetupStatus | null | undefined,
  t: TranslateFn = defaultT
): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'starting':
      return t('setup.startingRuntime', { runtime: OLLAMA_RUNTIME_LABEL })
    case 'downloading':
      return t('setup.downloadingRuntime', {
        runtime: OLLAMA_RUNTIME_LABEL,
        percent: status.percent
      })
    case 'pulling': {
      const modelLabel = getOllamaPullModelLabel(status.pullModel)
      if (status.percent === 0) {
        return t('setup.preparingModel', { model: modelLabel })
      }
      return t('setup.downloadingModel', { model: modelLabel, percent: status.percent })
    }
    case 'error':
      return status.error ?? t('setup.aiFailed')
    default:
      return null
  }
}
