import {
  getMeetingLanguageDefinition,
  type MeetingLanguageCode
} from '../../shared/meeting-language'

const RECORDING_COUNT_LABELS: Record<MeetingLanguageCode, string> = {
  en: 'Recordings',
  bg: 'Записи',
  hr: 'Snimke',
  cs: 'Nahrávky',
  da: 'Optagelser',
  nl: 'Opnamen',
  et: 'Salvestused',
  fi: 'Tallenteet',
  fr: 'Enregistrements',
  de: 'Aufnahmen',
  el: 'Ηχογραφήσεις',
  hu: 'Felvételek',
  it: 'Registrazioni',
  lv: 'Ieraksti',
  lt: 'Įrašai',
  pl: 'Nagrania',
  pt: 'Gravações',
  ro: 'Înregistrări',
  ru: 'Записи',
  sk: 'Nahrávky',
  sl: 'Posnetki',
  es: 'Grabaciones',
  sv: 'Inspelningar',
  uk: 'Записи',
  ja: '録音',
  'zh-Hans': '录音',
  ko: '녹음'
}

export function localizeRecordingCount(
  answer: string,
  language: MeetingLanguageCode
): string | null {
  const match = /^You have (\d+) recordings?\.$/.exec(answer)
  return match ? `${RECORDING_COUNT_LABELS[language]}: ${match[1]}` : null
}

export function chatLanguageInstruction(language: unknown): string {
  const { label } = getMeetingLanguageDefinition(language)
  return `Write the entire answer in ${label}, the user's selected meeting language, even when the question, conversation history, or source material is in another language. Preserve meeting titles, names, URLs, and quoted evidence.`
}
