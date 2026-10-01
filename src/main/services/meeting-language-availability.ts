import {
  DEFAULT_MEETING_LANGUAGE,
  isMeetingLanguageAvailable,
  meetingLanguageAvailability,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../shared/meeting-language'
import { logAutodocEvent } from './autodoc-log'
import { macUsesSmallNotesModel } from './mac-processing-profile'

/** Meeting languages this machine's notes model can write. */
export function currentMeetingLanguageAvailability(): MeetingLanguageAvailability {
  return meetingLanguageAvailability(macUsesSmallNotesModel())
}

/**
 * The language a new recording uses: the saved preference, or English when
 * this machine's notes model does not support it (for example a preference
 * carried over from a larger Mac). Settings explains the fallback.
 */
export function recordingMeetingLanguage(
  saved: MeetingLanguageCode,
  availability: MeetingLanguageAvailability = currentMeetingLanguageAvailability()
): MeetingLanguageCode {
  if (isMeetingLanguageAvailable(saved, availability)) return saved
  logAutodocEvent({
    area: 'recording',
    message: 'saved meeting language unavailable on this machine; recording in English',
    context: { savedLanguage: saved }
  })
  return DEFAULT_MEETING_LANGUAGE
}
