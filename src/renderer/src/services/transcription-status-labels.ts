import { translate, type MessageKey } from '../../../shared/i18n'
import { readCachedUiLanguage } from './document-language'
import type { TranscriptionStatusPayload } from '../../../shared/types'

export function formatTranscriptionStatusText(
  payload: Pick<TranscriptionStatusPayload, 'status' | 'progress'>,
  t: (key: MessageKey, params?: Record<string, string | number>) => string = (key, params) =>
    translate(readCachedUiLanguage(), key, params)
): string | null {
  if (payload.status !== 'transcribing') {
    return null
  }

  return payload.progress != null
    ? t('ui.transcribingPercent', { percent: payload.progress })
    : t('ui.transcribing')
}
