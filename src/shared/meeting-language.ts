export const DEFAULT_MEETING_LANGUAGE = 'en' as const

export const MEETING_LANGUAGE_DEFINITIONS = [
  { code: 'en', label: 'English' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'hr', label: 'Croatian' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'et', label: 'Estonian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'el', label: 'Greek' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'it', label: 'Italian' },
  { code: 'lv', label: 'Latvian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'mt', label: 'Maltese' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'es', label: 'Spanish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'uk', label: 'Ukrainian' }
] as const

export type MeetingLanguageCode = (typeof MEETING_LANGUAGE_DEFINITIONS)[number]['code']
export type MeetingLanguageDefinition = (typeof MEETING_LANGUAGE_DEFINITIONS)[number]

const MEETING_LANGUAGE_CODES = new Set<string>(MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => code))

export function isMeetingLanguageCode(value: unknown): value is MeetingLanguageCode {
  return typeof value === 'string' && MEETING_LANGUAGE_CODES.has(value)
}

/**
 * Treats absent, legacy, and invalid values as English so existing recordings
 * and installs retain AutoDoc's established transcription and notes behavior.
 */
export function normalizeMeetingLanguage(value: unknown): MeetingLanguageCode {
  if (typeof value !== 'string') return DEFAULT_MEETING_LANGUAGE

  const normalized = value.trim().toLocaleLowerCase()
  return isMeetingLanguageCode(normalized) ? normalized : DEFAULT_MEETING_LANGUAGE
}

export function isEnglishMeetingLanguage(value: unknown): boolean {
  return normalizeMeetingLanguage(value) === DEFAULT_MEETING_LANGUAGE
}

export function getMeetingLanguageDefinition(value: unknown): MeetingLanguageDefinition {
  const code = normalizeMeetingLanguage(value)
  return (
    MEETING_LANGUAGE_DEFINITIONS.find((definition) => definition.code === code) ??
    MEETING_LANGUAGE_DEFINITIONS[0]
  )
}
