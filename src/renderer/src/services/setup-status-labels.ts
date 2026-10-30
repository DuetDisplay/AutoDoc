import { translate, type MessageKey } from '../../../shared/i18n'
import { readCachedUiLanguage } from './document-language'
import type { OllamaSetupStatus, WhisperSetupStatus } from '../../../shared/types'

type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string

const defaultT: TranslateFn = (key, params) => translate(readCachedUiLanguage(), key, params)
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../../../shared/constants'

export function getWhisperSetupLabel(
  status: WhisperSetupStatus | null | undefined,
  t: TranslateFn = defaultT
): string | null {
  if (!status) {
    return null
  }

  switch (status.phase) {
    case 'checking':
      return t('setup.checkingEngine')
    case 'downloading-whisper':
      return t('setup.downloadingEngine', { percent: status.percent })
    case 'downloading-ffmpeg':
      return t('setup.installingAudioTools', { percent: status.percent })
    case 'downloading-model':
      return t('setup.downloadingSpeechModel', { percent: status.percent })
    case 'preparing-speaker-runtime':
      return t('setup.preparingSpeakerRuntime', { percent: status.percent })
    case 'installing-speaker-id':
      return t('setup.installingSpeakerId', { percent: status.percent })
    case 'downloading-speaker-model':
      return t('setup.downloadingSpeakerModel', { percent: status.percent })
    case 'error':
      return status.errorKind === 'disk-full'
        ? t('ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')
        : t('setup.transcriptionFailed')
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
      return t('setup.startingRuntime', { runtime: 'Ollama' })
    case 'downloading':
      return t('setup.downloadingRuntime', {
        runtime: 'Ollama',
        percent: status.percent
      })
    case 'pulling': {
      const embedding =
        !!status.pullModel &&
        (status.pullModel === DEFAULT_OLLAMA_EMBEDDING_MODEL ||
          status.pullModel.startsWith(`${DEFAULT_OLLAMA_EMBEDDING_MODEL}:`) ||
          status.pullModel.toLowerCase().includes('embedding'))
      if (status.percent === 0) {
        return embedding ? t('ui.preparingAskAISearchModel') : t('ui.preparingNotesModel')
      }
      return embedding
        ? t('ui.downloadingAskAISearchModelPercent', { percent: status.percent })
        : t('ui.downloadingNotesModelPercent', { percent: status.percent })
    }
    case 'error':
      return t('setup.aiFailed')
    default:
      return null
  }
}
