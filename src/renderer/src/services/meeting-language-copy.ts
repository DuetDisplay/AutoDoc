import type {
  MeetingLanguageEngineState,
  MeetingLanguageReasonCode
} from '../../../shared/meeting-language'
import { translate, type MessageKey } from '../../../shared/i18n'
import type { UiLanguageCode } from '../../../shared/ui-language'
import { formatBytes, formatMeetingLanguageFirstUseDownload } from './format-bytes'
import { readCachedUiLanguage } from './document-language'

export const SLOWER_MEETING_LANGUAGE_NOTE = 'Slower on this PC'
export const OFFLINE_DOWNLOAD_NOTE = 'Needs internet to download'

const REASON_MESSAGE_KEYS: Record<MeetingLanguageReasonCode, MessageKey> = {
  'needs-supported-graphics-card': 'picker.reasonNeedsGraphicsCard',
  'speech-runtime-missing': 'picker.reasonSpeechRuntimeMissing',
  'setup-disk-full': 'ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain',
  'setup-download-failed': 'picker.reasonSetupDownloadFailed',
  'setup-verification-failed': 'picker.reasonSetupVerificationFailed',
  'setup-failed': 'picker.reasonSetupFailed'
}

/**
 * Localized explanation for a machine-readable engine reason. The main process
 * sends a code beside its English `reason` (kept for logs), so the UI never
 * shows that English text. Null when no code is known.
 */
export function meetingLanguageReasonText(
  reasonCode: MeetingLanguageReasonCode | null | undefined,
  languageName: string,
  uiLanguage: UiLanguageCode = readCachedUiLanguage()
): string | null {
  if (!reasonCode) return null
  const key = REASON_MESSAGE_KEYS[reasonCode]
  if (!key) return null
  return translate(uiLanguage, key, { language: languageName })
}

export function meetingLanguageSelectableNote(
  engineState: MeetingLanguageEngineState | undefined,
  uiLanguage: UiLanguageCode = readCachedUiLanguage()
): string | null {
  if (!engineState || engineState.availability === 'locked') return null
  const sizeNote = formatMeetingLanguageFirstUseDownload(engineState.firstUseDownloadBytes)
  const slowerNote =
    engineState.availability === 'slower' ? translate(uiLanguage, 'picker.slowerOnThisPc') : null
  // A Mac language whose last setup attempt failed explains why, localized.
  if (engineState.availability === 'available' && engineState.reason) {
    const setupNote =
      meetingLanguageReasonText(engineState.reasonCode, '', uiLanguage) ??
      translate(uiLanguage, 'picker.reasonSetupFailed')
    return sizeNote ? `${setupNote} · ${sizeNote}` : setupNote
  }
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
