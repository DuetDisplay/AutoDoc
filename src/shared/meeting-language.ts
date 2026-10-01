export const DEFAULT_MEETING_LANGUAGE = 'en' as const

/**
 * Transcription engine family. `english` keeps today's route (Distil on macOS,
 * the current Parakeet route on Windows). `canary` is Canary-1B-v2 with the
 * meeting language pinned. `whisper-turbo` is Whisper large-v3-turbo, for
 * languages Canary cannot do.
 */
export type MeetingAsrRoute = 'english' | 'canary' | 'whisper-turbo'

/**
 * Held from the picker after the AD-100 run-4 eval (restore a row once fixed):
 * - el Greek: Canary's tokenizer cannot emit final sigma (NVIDIA-NeMo/Speech#15936).
 * - es Spanish, ru Russian: unknown-token rates and a party-name error.
 * - mt Maltese: below the language-identification threshold, garbled names.
 */
export const MEETING_LANGUAGE_DEFINITIONS = [
  { code: 'en', label: 'English', asr: 'english' },
  { code: 'bg', label: 'Bulgarian', asr: 'canary' },
  { code: 'hr', label: 'Croatian', asr: 'canary' },
  { code: 'cs', label: 'Czech', asr: 'canary' },
  { code: 'da', label: 'Danish', asr: 'canary' },
  { code: 'nl', label: 'Dutch', asr: 'canary' },
  { code: 'et', label: 'Estonian', asr: 'canary' },
  { code: 'fi', label: 'Finnish', asr: 'canary' },
  { code: 'fr', label: 'French', asr: 'canary' },
  { code: 'de', label: 'German', asr: 'canary' },
  { code: 'hu', label: 'Hungarian', asr: 'canary' },
  { code: 'it', label: 'Italian', asr: 'canary' },
  { code: 'lv', label: 'Latvian', asr: 'canary' },
  { code: 'lt', label: 'Lithuanian', asr: 'canary' },
  { code: 'pl', label: 'Polish', asr: 'canary' },
  { code: 'pt', label: 'Portuguese', asr: 'canary' },
  { code: 'ro', label: 'Romanian', asr: 'canary' },
  { code: 'sk', label: 'Slovak', asr: 'canary' },
  { code: 'sl', label: 'Slovenian', asr: 'canary' },
  { code: 'sv', label: 'Swedish', asr: 'canary' },
  { code: 'uk', label: 'Ukrainian', asr: 'canary' },
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

/**
 * Languages the small notes model on 8 GB Macs (`llama3.2:3b`) officially
 * supports, limited to picker rows. Meta documents en, de, fr, it, pt, hi, es
 * and th; Spanish is held and Hindi and Thai are not offered.
 */
export const SMALL_NOTES_MODEL_MEETING_LANGUAGES: readonly MeetingLanguageCode[] = [
  'en',
  'de',
  'fr',
  'it',
  'pt'
]

export interface MeetingLanguageAvailability {
  /** True when this machine writes notes with the small notes model. */
  restricted: boolean
  availableLanguages: readonly MeetingLanguageCode[]
}

export const UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY: MeetingLanguageAvailability = {
  restricted: false,
  availableLanguages: MEETING_LANGUAGE_DEFINITIONS.map((definition) => definition.code)
}

export function meetingLanguageAvailability(restricted: boolean): MeetingLanguageAvailability {
  return restricted
    ? { restricted, availableLanguages: SMALL_NOTES_MODEL_MEETING_LANGUAGES }
    : UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY
}

export function isMeetingLanguageAvailable(
  value: unknown,
  availability: MeetingLanguageAvailability
): boolean {
  return availability.availableLanguages.includes(normalizeMeetingLanguage(value))
}
