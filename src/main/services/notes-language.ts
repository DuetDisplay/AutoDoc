import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEFAULT_MEETING_LANGUAGE,
  getMeetingAsrRoute,
  getMeetingLanguageDefinition,
  isEnglishMeetingLanguage,
  normalizeMeetingLanguage,
  type MeetingAsrRoute,
  type MeetingLanguageCode
} from '../../shared/meeting-language'

/** Notes behavior gate. Missing, invalid, and legacy metadata resolve to English. */
export type NotesLanguageContext = 'english' | 'non-english'

export function notesLanguageContextFromMeetingLanguage(language: unknown): NotesLanguageContext {
  return isEnglishMeetingLanguage(language) ? 'english' : 'non-english'
}

const activeMeetingLanguageStore = new AsyncLocalStorage<MeetingLanguageCode>()

/**
 * Scopes one transcription or notes job to its recording's language. Enter the
 * scope where the job executes, never where it is queued, so a queued callback
 * cannot inherit another job's language. Outside any scope the language is English.
 */
export function runWithMeetingLanguage<T>(language: unknown, run: () => T): T {
  return activeMeetingLanguageStore.run(normalizeMeetingLanguage(language), run)
}

export function activeMeetingLanguage(): MeetingLanguageCode {
  return activeMeetingLanguageStore.getStore() ?? DEFAULT_MEETING_LANGUAGE
}

export function isEnglishMeetingJob(): boolean {
  return isEnglishMeetingLanguage(activeMeetingLanguage())
}

export function activeMeetingAsrRoute(): MeetingAsrRoute {
  return getMeetingAsrRoute(activeMeetingLanguage())
}

/**
 * The only place the output-language directive is built. English returns the
 * prompt unchanged, byte for byte. Other languages get the named language (never
 * the ISO code) as the final instruction of the request.
 */
export function appendMeetingLanguageDirective(prompt: string, language: unknown): string {
  if (isEnglishMeetingLanguage(language)) return prompt
  const { label } = getMeetingLanguageDefinition(language)
  return `${prompt}\n\nThe transcript is in ${label}. Write the entire response in ${label}, including every string value. JSON keys stay exactly as specified in English. Do not translate names, product names or technical terms.`
}
