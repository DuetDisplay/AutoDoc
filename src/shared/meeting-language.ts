export const DEFAULT_MEETING_LANGUAGE = 'en' as const

/**
 * Transcription engine family. `english` keeps today's route (Distil on macOS,
 * the current Parakeet route on Windows). `parakeet` is Parakeet TDT 0.6B v3.
 * `whisper-turbo` is Whisper large-v3-turbo, for languages Parakeet cannot do.
 */
export type MeetingAsrRoute = 'english' | 'parakeet' | 'whisper-turbo'

export const MEETING_LANGUAGE_DEFINITIONS = [
  { code: 'en', label: 'English', asr: 'english' },
  { code: 'bg', label: 'Bulgarian', asr: 'parakeet' },
  { code: 'hr', label: 'Croatian', asr: 'parakeet' },
  { code: 'cs', label: 'Czech', asr: 'parakeet' },
  { code: 'da', label: 'Danish', asr: 'parakeet' },
  { code: 'nl', label: 'Dutch', asr: 'parakeet' },
  { code: 'et', label: 'Estonian', asr: 'parakeet' },
  { code: 'fi', label: 'Finnish', asr: 'parakeet' },
  { code: 'fr', label: 'French', asr: 'parakeet' },
  { code: 'de', label: 'German', asr: 'parakeet' },
  { code: 'el', label: 'Greek', asr: 'parakeet' },
  { code: 'hu', label: 'Hungarian', asr: 'parakeet' },
  { code: 'it', label: 'Italian', asr: 'parakeet' },
  { code: 'lv', label: 'Latvian', asr: 'parakeet' },
  { code: 'lt', label: 'Lithuanian', asr: 'parakeet' },
  { code: 'mt', label: 'Maltese', asr: 'parakeet' },
  { code: 'pl', label: 'Polish', asr: 'parakeet' },
  { code: 'pt', label: 'Portuguese', asr: 'parakeet' },
  { code: 'ro', label: 'Romanian', asr: 'parakeet' },
  { code: 'ru', label: 'Russian', asr: 'parakeet' },
  { code: 'sk', label: 'Slovak', asr: 'parakeet' },
  { code: 'sl', label: 'Slovenian', asr: 'parakeet' },
  { code: 'es', label: 'Spanish', asr: 'parakeet' },
  { code: 'sv', label: 'Swedish', asr: 'parakeet' },
  { code: 'uk', label: 'Ukrainian', asr: 'parakeet' },
  { code: 'ja', label: 'Japanese', asr: 'whisper-turbo', decoderLanguage: 'ja' },
  { code: 'zh-Hans', label: 'Simplified Chinese', asr: 'whisper-turbo', decoderLanguage: 'zh' },
  { code: 'ko', label: 'Korean', asr: 'whisper-turbo', decoderLanguage: 'ko' }
] as const satisfies ReadonlyArray<{
  code: string
  label: string
  asr: MeetingAsrRoute
  /** Whisper decoder language pin. Only Whisper routes have one. */
  decoderLanguage?: string
}>

export type MeetingLanguageCode = (typeof MEETING_LANGUAGE_DEFINITIONS)[number]['code']
export type MeetingLanguageDefinition = (typeof MEETING_LANGUAGE_DEFINITIONS)[number]

const MEETING_LANGUAGE_CODES = new Set<string>(MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => code))

/** Lowercased codes and accepted aliases. Traditional Chinese and Cantonese are deliberately absent. */
const MEETING_LANGUAGE_BY_LOWERCASE = new Map<string, MeetingLanguageCode>([
  ...MEETING_LANGUAGE_DEFINITIONS.map(({ code }) => [code.toLowerCase(), code] as const),
  ['zh', 'zh-Hans'],
  ['zh-cn', 'zh-Hans'],
  ['cmn', 'zh-Hans']
])

export function isMeetingLanguageCode(value: unknown): value is MeetingLanguageCode {
  return typeof value === 'string' && MEETING_LANGUAGE_CODES.has(value)
}

/**
 * Treats absent, legacy, and invalid values as English so existing recordings
 * and installs retain AutoDoc's established transcription and notes behavior.
 */
export function normalizeMeetingLanguage(value: unknown): MeetingLanguageCode {
  if (typeof value !== 'string') return DEFAULT_MEETING_LANGUAGE
  return MEETING_LANGUAGE_BY_LOWERCASE.get(value.trim().toLowerCase()) ?? DEFAULT_MEETING_LANGUAGE
}

/** Notes, prompt, and grounding gate. Transcription switches on getMeetingAsrRoute. */
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

export function getMeetingAsrRoute(value: unknown): MeetingAsrRoute {
  return getMeetingLanguageDefinition(value).asr
}

export function isWhisperTurboMeetingLanguage(value: unknown): boolean {
  return getMeetingAsrRoute(value) === 'whisper-turbo'
}
