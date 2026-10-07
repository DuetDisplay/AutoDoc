export const DEFAULT_MEETING_LANGUAGE = 'en' as const

/**
 * Transcription engine family. `english` keeps today's route (Distil on macOS,
 * the current Parakeet route on Windows). `canary` is Canary-1B-v2 with the
 * meeting language pinned. `whisper-turbo` is Whisper large-v3-turbo, for
 * languages Canary cannot do.
 */
export type MeetingAsrRoute = 'english' | 'canary' | 'whisper-turbo'

/**
 * Greek, Spanish and Russian run on Whisper turbo, not Canary: on the run-4
 * clips Canary could not emit Greek final sigma (NVIDIA-NeMo/Speech#15936) and
 * produced unknown tokens and a party-name error in Spanish and Russian, while
 * turbo transcribed the same clips cleanly (2026-10-01).
 *
 * Held from the picker (restore a row once fixed):
 * - mt Maltese: garbled on both Canary and turbo.
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
  { code: 'el', label: 'Greek', asr: 'whisper-turbo', decoderLanguage: 'el' },
  { code: 'hu', label: 'Hungarian', asr: 'canary' },
  { code: 'it', label: 'Italian', asr: 'canary' },
  { code: 'lv', label: 'Latvian', asr: 'canary' },
  { code: 'lt', label: 'Lithuanian', asr: 'canary' },
  { code: 'pl', label: 'Polish', asr: 'canary' },
  { code: 'pt', label: 'Portuguese', asr: 'canary' },
  { code: 'ro', label: 'Romanian', asr: 'canary' },
  { code: 'ru', label: 'Russian', asr: 'whisper-turbo', decoderLanguage: 'ru' },
  { code: 'sk', label: 'Slovak', asr: 'canary' },
  { code: 'sl', label: 'Slovenian', asr: 'canary' },
  { code: 'es', label: 'Spanish', asr: 'whisper-turbo', decoderLanguage: 'es' },
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

const DENSE_SCRIPT_MEETING_LANGUAGES: readonly MeetingLanguageCode[] = ['ja', 'zh-Hans', 'ko']

/** Japanese, Chinese and Korean carry about one model token per character. */
export function isDenseScriptMeetingLanguage(value: unknown): boolean {
  return DENSE_SCRIPT_MEETING_LANGUAGES.includes(normalizeMeetingLanguage(value))
}

/**
 * Languages offered with the small notes model (`llama3.2:3b`, 8 GB Macs and
 * low-spec PCs). English only for 1.3.0: the e2e verification found the small
 * model invents transcript line citations in German and Spanish, so grounding
 * rejected every note on short meetings. Meta documents en, de, fr, it, pt,
 * hi, es and th; revisit with a stronger small model.
 */
export const SMALL_NOTES_MODEL_MEETING_LANGUAGES: readonly MeetingLanguageCode[] = ['en']

export type MeetingLanguageEngineAvailability = 'available' | 'slower' | 'locked'

/** Speech-engine state shared by Settings and onboarding on both platforms. */
export interface MeetingLanguageEngineState {
  availability: MeetingLanguageEngineAvailability
  reason: string | null
  engineId?: string | null
  firstUseDownloadBytes: number
  /** GPU engine is selected but its self-test has not run yet. */
  needsSelfTest?: boolean
}

export interface WindowsMeetingLanguageAvailabilityInfo {
  availability: MeetingLanguageEngineAvailability
  reason: string | null
  engineId: string | null
  firstUseDownloadBytes: number
  needsSelfTest?: boolean
}

export interface WindowsMultilingualEngineReadyInfo {
  engineId: string | null
  availability: MeetingLanguageEngineAvailability
  reason: string | null
  fallbackFrom?: string
  fallbackReason?: string | null
}

export interface MeetingLanguageAvailability {
  /** True when this machine writes notes with the small notes model. */
  restricted: boolean
  availableLanguages: readonly MeetingLanguageCode[]
  /** Per-language engine availability and remaining first-use download sizes. */
  languageStates?: Readonly<Partial<Record<MeetingLanguageCode, MeetingLanguageEngineState>>>
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
  const code = normalizeMeetingLanguage(value)
  if (!availability.availableLanguages.includes(code)) return false
  return availability.languageStates?.[code]?.availability !== 'locked'
}

/** OS locales include regions; never map Traditional Chinese to Simplified. */
export function defaultMeetingLanguageForLocale(
  locale: string,
  availability: MeetingLanguageAvailability
): MeetingLanguageCode {
  const tag = locale.toLowerCase().replaceAll('_', '-')
  const language = tag.startsWith('zh')
    ? normalizeMeetingLanguage(
        /hant|-(tw|hk|mo)(-|$)/.test(tag) ? 'en' : tag.startsWith('zh-hans') ? 'zh-Hans' : tag
      )
    : normalizeMeetingLanguage(tag.split('-')[0])
  return isMeetingLanguageAvailable(language, availability) ? language : DEFAULT_MEETING_LANGUAGE
}
