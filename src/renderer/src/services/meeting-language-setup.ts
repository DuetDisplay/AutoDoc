import type { MeetingLanguageAvailability } from '../../../shared/meeting-language'

/** Settings and onboarding use the same notes-model limits and engine states. */
export async function loadMeetingLanguageAvailability(): Promise<MeetingLanguageAvailability> {
  const [availability, languageStates] = await Promise.all([
    window.electronAPI.invoke('prefs:get-meeting-language-availability'),
    window.electronAPI.invoke('whisper:get-meeting-language-states')
  ])
  return { ...availability, languageStates }
}
