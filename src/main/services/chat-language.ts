import type { MeetingLanguageCode } from '../../shared/meeting-language'
import { chatReplyLanguageLabel, type ChatReplyLanguage } from './chat-reply-language'

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

export function localizeRecordingCount(answer: string, language: ChatReplyLanguage): string | null {
  const match = /^You have (\d+) recordings?\.$/.exec(answer)
  const label = RECORDING_COUNT_LABELS[language as MeetingLanguageCode]
  return match && label ? `${label}: ${match[1]}` : null
}

export function chatLanguageInstruction(language: unknown): string {
  const label = chatReplyLanguageLabel(language)
  return `Write the entire answer in ${label}, the reply language for this request. Source material or earlier turns in another language must not override it. Preserve meeting titles, names, URLs, and quoted evidence.`
}

/** Preserve authoritative totals/titles without a generative translation. */
export function localizeRecordingList(answer: string, language: ChatReplyLanguage): string | null {
  if (language === 'en' || !RECORDING_COUNT_LABELS[language as MeetingLanguageCode]) return null
  const total = /I found (\d+) recordings? total/.exec(answer)?.[1]
  const lines = answer.split('\n').filter((line) => /^\d+\. /.test(line))
  if (!total || !/^Here are your (?:most recent )?recordings:/.test(answer)) return null
  return `${RECORDING_COUNT_LABELS[language as MeetingLanguageCode]}: ${total}\n${lines.length}/${total}\n\n${lines.join('\n')}`
}
