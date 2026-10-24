import type { SpeakerInfo } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'

export function displaySpeakerLabel(
  speakerId: string,
  info: SpeakerInfo | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): string {
  const label =
    info?.label ??
    (speakerId === 'me'
      ? 'Me'
      : speakerId === 'them'
        ? 'Them'
        : speakerId.replace(/^speaker_(\d+)$/, 'Speaker $1'))
  if (info?.customLabel) return label
  if (label === 'Speaker') return t('speaker.unknown')
  if (speakerId === 'me' && label === 'Me') return t('speaker.me')
  if (speakerId === 'them' && label === 'Them') return t('speaker.them')
  const numbered = /^Speaker (\d+)$/.exec(label)
  return numbered ? t('speaker.number', { number: Number(numbered[1]) }) : label
}
