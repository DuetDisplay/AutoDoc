import { describe, expect, it } from 'vitest'
import {
  chatReplyRequest,
  detectChatQuestionLanguage,
  resolveChatReplyLanguage
} from '../chat-reply-language'

// One question per supported reply language, in its native wording.
const recordingQuestions: Array<[string, string]> = [
  ['en', 'Which meetings did I record last week?'],
  ['fr', 'Quelles réunions ai-je enregistrées la semaine dernière ?'],
  ['ja', '先週録音した会議はどれですか？'],
  ['de', 'Welche Besprechungen habe ich letzte Woche aufgenommen?'],
  ['es', '¿Qué reuniones grabé la semana pasada?'],
  ['it', 'Quali riunioni ho registrato la settimana scorsa?'],
  ['pt', 'Que reuniões gravei na semana passada?'],
  ['ru', 'Сколько встреч я записал в этом месяце?'],
  ['uk', 'Які зустрічі я записав минулого тижня?'],
  ['zh-Hans', '我上周录制了哪些会议？'],
  ['ko', '지난주에 녹음한 회의는 무엇인가요?'],
  ['nl', 'Welke vergaderingen heb ik vorige week opgenomen?'],
  ['pl', 'Które spotkania nagrałem w zeszłym tygodniu?'],
  ['cs', 'Které schůzky jsem minulý týden nahrál?'],
  ['sk', 'Ktoré stretnutia som minulý týždeň nahral?'],
  ['sv', 'Vilka möten spelade jag in förra veckan?'],
  ['da', 'Hvilke møder optog jeg i sidste uge?'],
  ['fi', 'Mitkä kokoukset nauhoitin viime viikolla?'],
  ['hu', 'Melyik megbeszéléseket rögzítettem a múlt héten?'],
  ['ro', 'Ce întâlniri am înregistrat săptămâna trecută?'],
  ['el', 'Ποιες συναντήσεις ηχογράφησα την περασμένη εβδομάδα;'],
  ['bg', 'Кои срещи записах миналата седмица?'],
  ['hr', 'Koje sam sastanke snimio prošli tjedan?'],
  ['sl', 'Koliko sestankov sem posnel ta mesec?'],
  ['et', 'Kui palju koosolekuid ma sel kuul salvestasin?'],
  ['lv', 'Cik sapulču es ierakstīju šomēnes?'],
  ['lt', 'Kuriuos susitikimus įrašiau praėjusią savaitę?']
]
const deadlineQuestions: Array<[string, string]> = [
  ['en', 'When is the Harbor budget review due?'],
  ['fr', 'Quand la revue budgétaire de Harbor est-elle prévue ?'],
  ['ja', 'Harborの予算レビューの期限はいつですか？'],
  ['de', 'Wann ist die Budgetprüfung für Harbor fällig?'],
  ['es', '¿Cuándo vence la revisión del presupuesto de Harbor?'],
  ['it', 'Entro quando dobbiamo finire la revisione del budget di Harbor?'],
  ['pt', 'Quando é o prazo da revisão do orçamento do Harbor?'],
  ['ru', 'Когда нужно сдать проверку бюджета Harbor?'],
  ['uk', 'Коли потрібно здати перевірку бюджету Harbor?'],
  ['zh-Hans', 'Harbor预算审查的截止日期是什么时候？'],
  ['ko', 'Harbor 예산 검토 마감일은 언제인가요?'],
  ['nl', 'Wanneer moet de budgetcontrole van Harbor klaar zijn?'],
  ['pl', 'Kiedy mija termin przeglądu budżetu Harbor?'],
  ['cs', 'Kdy je termín kontroly rozpočtu Harbor?'],
  ['sk', 'Dokedy musíme dokončiť kontrolu rozpočtu pre Harbor?'],
  ['sv', 'När ska budgetgranskningen för Harbor vara klar?'],
  ['da', 'Hvornår skal budgetgennemgangen for Harbor være færdig?'],
  ['fi', 'Mihin mennessä Harborin budjetin tarkistus pitää tehdä?'],
  ['hu', 'Mikor esedékes a Harbor költségvetési felülvizsgálata?'],
  ['ro', 'Când este termenul pentru revizuirea bugetului Harbor?'],
  ['el', 'Πότε λήγει ο έλεγχος του προϋπολογισμού του Harbor;'],
  ['bg', 'Кога е крайният срок за прегледа на бюджета на Harbor?'],
  ['hr', 'Kada je rok za pregled proračuna za Harbor?'],
  ['sl', 'Do kdaj moramo dokončati pregled proračuna za Harbor?'],
  ['et', 'Millal on Harbori eelarve ülevaatuse tähtaeg?'],
  ['lv', 'Kad ir Harbor budžeta pārskatīšanas termiņš?'],
  ['lt', 'Kada baigiasi Harbor biudžeto peržiūros terminas?']
]

describe('Ask AI reply language', () => {
  it.each([
    ['What is the Atlas budget?', 'en'],
    ['When will Sakura launch?', 'en'],
    ['Quel est le budget Atlas ?', 'fr'],
    ['Et son budget ?', 'fr'],
    ['¿Cuál es el presupuesto de Atlas?', 'es'],
    ['さくらの発売日はいつですか？', 'ja']
  ])(
    'recognizes a current question independently of meeting settings: %s',
    (question, language) => {
      expect(resolveChatReplyLanguage(question, [], language === 'en' ? 'fr' : 'en')).toBe(language)
    }
  )
  it('gives explicit directives priority and strips them only for retrieval', () => {
    expect(chatReplyRequest('What is the Atlas budget? Answer in Japanese.')).toEqual({
      question: 'What is the Atlas budget?',
      explicitLanguage: 'ja'
    })
    expect(
      resolveChatReplyLanguage('What is the Atlas budget? Answer in Japanese.', [], 'fr')
    ).toBe('ja')
    expect(resolveChatReplyLanguage('Quel est le budget ? Réponds en anglais.', [], 'fr')).toBe(
      'en'
    )
    expect(resolveChatReplyLanguage('予算は？日本語で答えて', [], 'en')).toBe('ja')
    expect(resolveChatReplyLanguage('¿Cuál es el presupuesto? Responde en inglés.', [], 'fr')).toBe(
      'en'
    )
    expect(resolveChatReplyLanguage('予算は？英語で答えて', [], 'ja')).toBe('en')
  })
  it('does not apply quoted or negated language directives', () => {
    expect(chatReplyRequest('Why did he say "reply in French"?').explicitLanguage).toBeUndefined()
    expect(
      chatReplyRequest('Do not answer in French. What is the budget?').explicitLanguage
    ).toBeUndefined()
  })
  it('uses conversation language for ambiguous turns and meeting language only as fallback', () => {
    expect(resolveChatReplyLanguage('yes', [], 'en', 'fr')).toBe('fr')
    expect(
      resolveChatReplyLanguage('Atlas?', [{ role: 'user', content: 'Quel est le budget ?' }], 'en')
    ).toBe('fr')
    expect(resolveChatReplyLanguage('yes', [], 'fr')).toBe('fr')
    expect(resolveChatReplyLanguage('What is the budget?', [], 'fr', 'ja')).toBe('en')
  })
  it.each(recordingQuestions)(
    'recognizes supported native recording wording: %s',
    (language, question) => {
      expect(detectChatQuestionLanguage(question)).toBe(language)
    }
  )
  it.each(deadlineQuestions)(
    'recognizes supported native factual wording: %s',
    (language, question) => {
      expect(detectChatQuestionLanguage(question)).toBe(language)
    }
  )
})

// Statistical language detection, rather than a growing set of editing commands.
it('recognizes previously unseen short English editing requests', () => {
  for (const question of [
    'Shorten that.',
    'Can you make that more concise?',
    'Cut this down a bit.'
  ])
    expect(detectChatQuestionLanguage(question)).toBe('en')
})

// AD-202: franc alone read these short English questions as Indonesian.
it.each([
  'can monkeys eats bananas?',
  'can monkeys eat bananas?',
  'do monkeys eat bananas?',
  'does Atlas have a budget?',
  'did Mira sign off?',
  'can parrots eat carrots?'
])('keeps an English auxiliary question in English: %s', (question) => {
  expect(detectChatQuestionLanguage(question)).toBe('en')
})

// AD-202: too short for either detector; franc read these as French, Italian or Dutch.
it.each(['is it done?', 'is it late?', 'are we done?', 'is it over budget?', 'is it raining?'])(
  'keeps a short English auxiliary-pronoun question in English: %s',
  (question) => {
    expect(detectChatQuestionLanguage(question)).toBe('en')
  }
)

it.each([
  ['Is het klaar?', 'nl'],
  ['Is dit goedgekeurd?', 'nl'],
  ['Hebben we een deadline?', 'nl'],
  ['Was het budget goedgekeurd?', 'nl'],
  ['Was ist das?', 'de'],
  ['Do i soldi a Giulia?', 'it'],
  ['Do i compiti a chi?', 'it']
])('keeps a short non-English question whose opener looks English: %s', (question, language) => {
  expect(detectChatQuestionLanguage(question)).toBe(language)
})

it.each([
  ['Is het budget goedgekeurd?', 'nl'],
  ['Is Mira klaar?', 'nl'],
  ['Was de vergadering lang?', 'nl'],
  ['Was Harbor goedgekeurd?', 'nl'],
  ['Was ist die Frist?', 'de'],
  ['Was hat Nico gesagt?', 'de'],
  ['Will er die Folien senden?', 'de'],
  ['Hat Mira zugestimmt?', 'de'],
  ['Do kiedy trzeba to zrobić?', 'pl'],
  ['Do kiedy?', 'pl'],
  ['Do której godziny?', 'pl'],
  ['Do que se trata a reunião?', 'pt'],
  ['Do meio da tarde?', 'pt'],
  ['Do čtvrtka to stihneme?', 'cs'],
  ['Are cineva cheia?', 'ro'],
  ['Are Mira termenul?', 'ro'],
  ['Apakah monyet makan pisang?', 'id'],
  ['Siapa yang bertanggung jawab?', 'id']
])('does not let an English-looking opener override another language: %s', (question, language) => {
  expect(detectChatQuestionLanguage(question)).toBe(language)
})

it('uses full French sentence evidence before an ambiguous English opening cue', () => {
  expect(
    detectChatQuestionLanguage(
      'Compare les décisions de ces deux réunions et explique leurs différences.'
    )
  ).toBe('fr')
})
