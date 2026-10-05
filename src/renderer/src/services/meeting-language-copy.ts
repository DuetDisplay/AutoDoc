import type { MeetingLanguageEngineState } from '../../../shared/meeting-language'
import { formatMeetingLanguageFirstUseDownload } from './format-bytes'

export const SLOWER_MEETING_LANGUAGE_NOTE = 'Slower on this PC'

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
