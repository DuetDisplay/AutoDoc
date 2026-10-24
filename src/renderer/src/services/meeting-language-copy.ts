import type { MeetingLanguageEngineState } from '../../../shared/meeting-language'
import { translate } from '../../../shared/i18n'
import { formatBytes, formatMeetingLanguageFirstUseDownload } from './format-bytes'
import { readCachedUiLanguage } from './document-language'

export const SLOWER_MEETING_LANGUAGE_NOTE = 'Slower on this PC'
export const OFFLINE_DOWNLOAD_NOTE = 'Needs internet to download'

export function meetingLanguageSelectableNote(
  engineState: MeetingLanguageEngineState | undefined
): string | null {
  if (!engineState || engineState.availability === 'locked') return null
  const sizeNote = formatMeetingLanguageFirstUseDownload(engineState.firstUseDownloadBytes)
  const slowerNote =
    engineState.availability === 'slower'
      ? translate(readCachedUiLanguage(), 'picker.slowerOnThisPc')
      : null
  if (slowerNote && sizeNote) return `${slowerNote} · ${sizeNote}`
  return slowerNote ?? sizeNote
}

/** Shown when a language's first-use download fails because the machine is offline. */
export function offlineMeetingLanguageMessage(
  languageLabel: string,
  downloadBytes?: number | null,
  currentLanguageLabel?: string | null
): string {
  const language = readCachedUiLanguage()
  const message =
    downloadBytes && downloadBytes > 0
      ? translate(
          language,
          'ui.youReOfflineConnectToTheInternetToDownloadTheLanguageSpeechModelAboutSize',
          { language: languageLabel, size: formatBytes(downloadBytes, language) }
        )
      : translate(language, 'ui.youReOfflineConnectToTheInternetToDownloadTheLanguageSpeechModel', {
          language: languageLabel
        })
  return currentLanguageLabel
    ? [
        message,
        translate(language, 'ui.yourMeetingLanguageIsStillLanguage', {
          language: currentLanguageLabel
        })
      ].join(' ')
    : message
}
