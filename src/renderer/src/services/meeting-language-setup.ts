import {
  MEETING_LANGUAGE_DEFINITIONS,
  type MeetingLanguageCode,
  type MeetingLanguageEngineState,
  type MeetingLanguageAvailability
} from '../../../shared/meeting-language'

/** Settings and onboarding use the same notes-model limits and engine states. */
export async function loadMeetingLanguageAvailability(): Promise<MeetingLanguageAvailability> {
  const [availability, runtime] = await Promise.all([
    window.electronAPI.invoke('prefs:get-meeting-language-availability'),
    window.electronAPI.invoke('app:get-runtime-info')
  ])
  return { ...availability, languageStates: await loadMeetingLanguageStates(runtime.platform) }
}

export async function loadMeetingLanguageStates(
  platform: string
): Promise<Partial<Record<MeetingLanguageCode, MeetingLanguageEngineState>>> {
  if (platform !== 'win32')
    return (await window.electronAPI.invoke('whisper:get-meeting-language-states')) ?? {}
  const entries = await Promise.all(
    MEETING_LANGUAGE_DEFINITIONS.filter((definition) => definition.code !== 'en').map(
      async (definition) => {
        const result = await window.electronAPI.invoke(
          'whisper:get-windows-meeting-language-availability',
          definition.code
        )
        return [definition.code, result] as const
      }
    )
  )
  return Object.fromEntries(entries)
}
