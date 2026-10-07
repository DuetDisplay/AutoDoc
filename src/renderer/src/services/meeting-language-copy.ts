import type { MeetingLanguageEngineState } from '../../../shared/meeting-language'
import { formatBytes, formatMeetingLanguageFirstUseDownload } from './format-bytes'

export const SLOWER_MEETING_LANGUAGE_NOTE = 'Slower on this PC'
export const OFFLINE_DOWNLOAD_NOTE = 'Needs internet to download'

export function meetingLanguageSelectableNote(
  engineState: MeetingLanguageEngineState | undefined
): string | null {
  if (!engineState || engineState.availability === 'locked') return null
  const sizeNote = formatMeetingLanguageFirstUseDownload(engineState.firstUseDownloadBytes)
  const slowerNote = engineState.availability === 'slower' ? SLOWER_MEETING_LANGUAGE_NOTE : null
  if (engineState.availability === 'available' && engineState.reason) {
    return sizeNote ? `${engineState.reason} · ${sizeNote}` : engineState.reason
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
  const size = downloadBytes && downloadBytes > 0 ? ` (about ${formatBytes(downloadBytes)})` : ''
  const current = currentLanguageLabel
    ? ` Your meeting language is still ${currentLanguageLabel}.`
    : ''
  return `You're offline. Connect to the internet to download the ${languageLabel} speech model${size}.${current}`
}
