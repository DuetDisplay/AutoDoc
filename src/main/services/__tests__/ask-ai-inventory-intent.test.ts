import { describe, expect, it } from 'vitest'
import { parseAskAiQuestion } from '../ask-ai-query'
import { nativeInventoryIntent, hasInventoryRequestCue } from '../ask-ai-inventory-intent'

describe('conservative native inventory intents', () => {
  it('clarifies unknown qualifiers instead of counting retrieved excerpts', () => {
    expect(hasInventoryRequestCue('Combien de réunions enregistrées parlent du budget ?')).toBe(
      true
    )
    expect(hasInventoryRequestCue('録音した会議はいくつありますか昨日')).toBe(true)
    expect(hasInventoryRequestCue('How many recordings discussed Atlas?')).toBe(true)
    expect(hasInventoryRequestCue('How many replicas does Harbor have?')).toBe(false)
  })
  it.each([
    'Combien de réunions enregistrées ai-je ?',
    "Combien d'enregistrements ai-je ?",
    '録音した会議はいくつありますか？',
    'Wie viele Aufnahmen habe ich?',
    'Cuántas grabaciones tengo?',
    '¿Cuántas grabaciones tengo?',
    'Quante registrazioni ho?',
    'Quantas gravações tenho?',
    'Сколько у меня записей?',
    'Скільки в мене записів?',
    '我有多少录音？',
    '녹음한 회의는 몇 개인가요?',
    'Hoeveel opnames heb ik?',
    'Ile mam nagrań?',
    'Kolik mám nahrávek?',
    'Koľko mám nahrávok?',
    'Hur många inspelningar har jag?',
    'Hvor mange optagelser har jeg?',
    'Kuinka monta tallennetta minulla on?',
    'Hány felvételem van?',
    'Câte înregistrări am?',
    'Πόσες ηχογραφήσεις έχω;',
    'Колко записа имам?',
    'Koliko snimki imam?',
    'Koliko posnetkov imam?',
    'Mitu salvestist mul on?',
    'Cik ierakstu man ir?',
    'Kiek įrašų turiu?',
    // AD-202: an existence question is answered by the same saved-recording count.
    'Do i have recordings?',
    'Do I have any recordings?',
    'do I have recorded meetings'
  ])('routes %s to authoritative count', (question) => {
    expect(parseAskAiQuestion(question).act).toBe('count')
  })
  it.each([
    'Liste mes réunions enregistrées.',
    '録音した会議の一覧を見せてください。',
    'Zeige meine Aufnahmen',
    'Lista mis grabaciones',
    '显示我的录音'
  ])('routes %s to authoritative list', (question) => {
    expect(parseAskAiQuestion(question).act).toBe('list')
  })
  it.each([
    'How many replicas does Harbor have?',
    'How many meetings discussed Atlas?',
    'Combien de réunions enregistrées parlent du budget ?',
    'Liste mes réunions enregistrées sur Atlas.',
    '録音した会議で何件の決定をしましたか？',
    '録音した会議はいくつありますか昨日',
    'How many recordings do I have yesterday?',
    'Delete my recordings',
    'Do I have recordings about Atlas?',
    'Do I have recordings from yesterday?'
  ])(
    'does not turn a topical/action/window request into an unfiltered inventory: %s',
    (question) => {
      expect(nativeInventoryIntent(question)).toBeNull()
    }
  )
})
