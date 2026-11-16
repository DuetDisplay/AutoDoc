import { detectAll } from 'tinyld'
import { francAll } from 'franc'
import { normalizeMeetingLanguage } from '../../shared/meeting-language'

/** Reply languages are independent of the ASR/notes language setting. */
export type ChatReplyLanguage = string
const languages = [
  ['en', 'eng', 'English', 'anglais'],
  ['fr', 'fra', 'French', 'français', 'francais'],
  ['de', 'deu', 'German', 'allemand', 'Deutsch'],
  ['es', 'spa', 'Spanish', 'espagnol', 'español'],
  ['it', 'ita', 'Italian', 'italien', 'italiano'],
  ['pt', 'por', 'Portuguese', 'portugais', 'português'],
  ['nl', 'nld', 'Dutch', 'néerlandais'],
  ['da', 'dan', 'Danish', 'danois'],
  ['sv', 'swe', 'Swedish', 'suédois'],
  ['fi', 'fin', 'Finnish', 'finnois'],
  ['hu', 'hun', 'Hungarian', 'hongrois'],
  ['ro', 'ron', 'Romanian', 'roumain'],
  ['pl', 'pol', 'Polish', 'polonais'],
  ['cs', 'ces', 'Czech', 'tchèque'],
  ['sk', 'slk', 'Slovak', 'slovaque'],
  ['hr', 'hrv', 'Croatian', 'croate'],
  ['sl', 'slv', 'Slovenian', 'slovène'],
  ['et', 'est', 'Estonian', 'estonien'],
  ['lv', 'lav', 'Latvian', 'letton'],
  ['lt', 'lit', 'Lithuanian', 'lituanien'],
  ['ru', 'rus', 'Russian', 'russe', 'русский'],
  ['uk', 'ukr', 'Ukrainian', 'ukrainien', 'українська'],
  ['bg', 'bul', 'Bulgarian', 'bulgare'],
  ['el', 'ell', 'Greek', 'grec'],
  ['ja', 'jpn', 'Japanese', 'japonais', '日本語'],
  ['zh-Hans', 'cmn', 'Chinese', 'chinois', '中文'],
  ['ko', 'kor', 'Korean', 'coréen', '한국어'],
  ['ar', 'arb', 'Arabic', 'arabe', 'العربية'],
  ['hi', 'hin', 'Hindi', 'हिन्दी'],
  ['he', 'heb', 'Hebrew', 'hébreu'],
  ['tr', 'tur', 'Turkish', 'turc'],
  ['vi', 'vie', 'Vietnamese', 'vietnamien'],
  ['id', 'ind', 'Indonesian', 'indonésien'],
  ['th', 'tha', 'Thai', 'thaï'],
  ['fa', 'pes', 'Persian', 'persan']
] as const
const byIso = new Map<string, string>(languages.map(([code, iso]) => [iso, code]))
const aliases = new Map<string, string>(
  languages.flatMap(([code, , ...names]) =>
    names.map((name) => [name.toLowerCase(), code] as const)
  )
)
// Resolve familiar native language names locally as well as English labels.
for (const locale of ['fr', 'es', 'de', 'ja', 'zh', 'ko']) {
  const names = new Intl.DisplayNames([locale], { type: 'language' })
  for (const [code] of languages) {
    const name = names.of(code)
    if (name) aliases.set(name.toLowerCase(), code)
  }
}
const languageNames = [...aliases.keys()]
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')
const explicit = new RegExp(
  `\\b(?:answer|respond|reply|write)(?:\\s+(?:me|the answer|your answer|only|please))?\\s+in\\s+(${languageNames})(?!\\p{L})|\\b(?:réponds?|répondez|répondre|écris|écrivez)(?:[- ]moi)?\\s+en\\s+(${languageNames})(?!\\p{L})|\\b(?:responde|responda|contesta|escribe)\\s+en\\s+(${languageNames})(?!\\p{L})|\\b(?:antworte|antworten|schreibe)\\s+auf\\s+(${languageNames})(?!\\p{L})|(?:(${languageNames})で(?:答え(?:て(?:ください)?)?|(?:回答|返答|説明)(?:して(?:ください)?)?|書(?:いて(?:ください)?)?))`,
  'giu'
)
const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
export function chatReplyLanguageLabel(language: unknown): string {
  if (typeof language !== 'string') return 'English'
  try {
    return displayNames.of(language) ?? 'English'
  } catch {
    return 'English'
  }
}

function unquoted(text: string): string {
  return text.replace(
    /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|(?<!\p{L})'[^'\n]*'(?!\p{L})/gu,
    (match) => ' '.repeat(match.length)
  )
}

/** Remove only a requested output-language directive, never a topic/date filter. */
export function chatReplyRequest(question: string): {
  question: string
  explicitLanguage?: string
} {
  let explicitLanguage: string | undefined
  const visible = unquoted(question)
  explicit.lastIndex = 0
  const matches = [...visible.matchAll(explicit)]
  let cleaned = question
  const removals: Array<[number, number]> = []
  for (const match of matches) {
    const before = visible.slice(Math.max(0, match.index! - 24), match.index)
    if (/(?:don't|do not|never|not|ne pas)\s*$/iu.test(before)) continue
    const alias = match
      .slice(1)
      .find((value) => value !== undefined)!
      .toLowerCase()
    explicitLanguage = aliases.get(alias)
    removals.push([match.index!, match[0].length])
  }
  for (const [index, length] of removals.reverse())
    cleaned = cleaned.slice(0, index) + cleaned.slice(index + length)
  cleaned = cleaned
    .replace(/(?:[.!?。！？]\s*){2,}/gu, '? ')
    .replace(/[;,]\s*$/u, '')
    .trim()
  return { question: cleaned || question, explicitLanguage }
}

// Short questions are a poor statistical sample. Distinctive question/function
// words disambiguate common languages; proper names and bare confirmations don't.
const questionCues: Array<[string, RegExp]> = [
  ['pt', /^(?:qual|quais|quem|quant[oa]s?)(?!\p{L})/iu],
  ['nl', /^(?:hoeveel|wie (?:is|heeft)|toon mijn)(?!\p{L})/iu],
  ['cs', /(?:^|[^\p{L}])(?:kolik|odpovědný|odpovědná|nahrávek)(?!\p{L})/iu],
  ['lt', /(?:^|[^\p{L}])(?:kiek|atsakingas|atsakinga)(?!\p{L})/iu],
  [
    'en',
    /^(?:what|which|who|whom|whose|when|where|why|how|explain|summari[sz]e|compare|show|list|tell|give|describe|verify|confirm|please)\b/iu
  ],
  [
    'fr',
    /^(?:quel(?:le)?s?|qui|quand|pourquoi|combien|comment|où|est-ce|peux-tu|pouvez-vous|résume|explique|montre|et (?:son|sa|ses|le|la|les))(?!\p{L})/iu
  ],
  [
    'es',
    /^(?:cu[aá]l(?:es)?|qui[eé]n(?:es)?|cu[aá]ndo|por qu[eé]|cu[aá]nt[oa]s?|c[oó]mo|d[oó]nde)\b/iu
  ],
  ['de', /^(?:wer|wann|warum|welch\p{L}*|wie viele|was (?:ist|war|sind|hat|haben))\b/iu],
  ['ru', /^(?:кто|что|когда|сколько|почему|где|какой|какая)(?!\p{L})/iu],
  ['uk', /^(?:хто|що|коли|скільки|чому|який|яка)(?!\p{L})/iu],
  ['bg', /^(?:колко|какъв|каква|кой|коя)(?!\p{L})/iu],
  ['et', /^(?:kes|mis|millal|mitu|kuidas)\b/iu],
  ['lv', /^(?:kurš|kura|kāds|cik|kad|kāpēc)(?!\p{L})/iu],
  ['ro', /^(?:cine|când|câte|cât|care|cum)(?!\p{L})/iu],
  ['pl', /^(?:ile|kiedy|dlaczego|jaki|jakie)\b/iu],
  ['hr', /\b(?:tko|snimki|snimke|odgovoran)\b/iu],
  ['sl', /\b(?:posnetkov|posnetke|odgovoren|migracijo)\b/iu]
]

const englishAuxiliaryOpening =
  /^(?:can|could|do|does|did|is|are|was|were|will|would|should|have|has)(?!\p{L})/iu
// Not "do i" or "do my": Italian "Do i documenti a Marco?" and Polish "Do my…" start the same way.
const englishQuestionOpening =
  /^(?!do\s+(?:i|my)(?!\p{L}))(?:can|could|do|does|did|is|are|was|were|will|would|should|have|has)\s+(?:i|you|we|they|he|she|it|this|that|these|those|there|the|my|our|your|their|anyone|anybody|anything|someone|somebody|something|everyone|everything)(?!\p{L})/iu

export function detectChatQuestionLanguage(question: string): string | undefined {
  const text = unquoted(chatReplyRequest(question).question)
    .normalize('NFKC')
    .trim()
    .replace(/^[¿¡]+/u, '')
  if (
    /^(?:yes|no|ok(?:ay)?|sure|thanks?|oui|non|si|sí|ja|да|はい|いいえ|ありがとう)[.!?。！？\s]*$/iu.test(
      text
    )
  )
    return undefined
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja'
  if (/\p{Script=Hangul}/u.test(text)) return 'ko'
  if (
    /\p{Script=Han}/u.test(text) &&
    !/[\p{Script=Latin}\p{Script=Cyrillic}]/u.test(text.replace(/\b[A-Z][a-z]+\b/g, ''))
  )
    return 'zh-Hans'
  const words = text.match(/\p{L}+/gu) ?? []
  // Independent local statistical evidence helps short editing requests,
  // without adding a list of supported commands or question phrases.
  const detected = detectAll(text.slice(0, 2000))[0]
  const detectedCode = detected?.lang === 'zh' ? 'zh-Hans' : detected?.lang
  const supportedDetection = languages.some(([code]) => code === detectedCode)
  const cue = questionCues.find(([, pattern]) => pattern.test(text))?.[0]
  if (cue && detectedCode === cue) return cue
  // An English auxiliary opening ("can/do/is …") with a certain English tinyld result is
  // English. franc alone read "Can monkeys eat bananas?" as Indonesian (AD-202). The
  // opener is only a corroborating cue: it never overrides another language on its own.
  if (englishAuxiliaryOpening.test(text) && detected?.lang === 'en' && detected.accuracy >= 0.99)
    return 'en'
  // Both detectors misread short questions: "is it done?" as French, "is it over budget?" as
  // Dutch (AD-202). In a question of up to six words, an auxiliary followed by an English
  // pronoun or determiner ("is it", "are we", "did anyone") is English. Dutch "is het" and
  // German "was ist" don't match, and another language's question cue still wins.
  if (words.length <= 6 && englishQuestionOpening.test(text) && (!cue || cue === 'en')) return 'en'
  const candidates = francAll(text.slice(0, 2000), { only: [...byIso.keys()], minLength: 10 })
  const [first, second] = candidates
  // Full-sentence evidence outranks an ambiguous opening verb or a name.
  // tinyld's confidence is not calibrated: a project word can return 1.0 in
  // the wrong language, so corroborate longer requests with the other detector.
  if (words.length >= 4 && first?.[0] !== 'und' && first &&
    (!second || first[1] - second[1] >= 0.06)) return byIso.get(first[0])
  for (const [language, pattern] of questionCues) if (pattern.test(text)) return language
  if (
    words.length >= 2 &&
    detected?.accuracy >= (words.length < 3 ? 0.99 : 0.5) &&
    supportedDetection
  )
    return detectedCode
  if (
    words.length < 3 &&
    !/[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(text)
  )
    return undefined
  if (!first || first[0] === 'und') return undefined
  // On inconclusive short samples retain the conversation language rather than
  // asserting a new locale on the strength of a project/person name.
  if (second && first[1] - second[1] < 0.06) return undefined
  return byIso.get(first[0])
}

export function resolveChatReplyLanguage(
  question: string,
  history: Array<{ role: string; content: string }>,
  meetingLanguage: unknown,
  conversationLanguage?: string
): ChatReplyLanguage {
  const explicitLanguage = chatReplyRequest(question).explicitLanguage
  const current = explicitLanguage ?? detectChatQuestionLanguage(question)
  if (current) return current
  if (conversationLanguage) return conversationLanguage
  for (const message of [...history].reverse()) {
    if (message.role !== 'user') continue
    const language =
      chatReplyRequest(message.content).explicitLanguage ??
      detectChatQuestionLanguage(message.content)
    if (language) return language
  }
  return normalizeMeetingLanguage(meetingLanguage)
}

export function mentionsReplyLanguage(question: string): boolean {
  return new RegExp(`(?<!\\p{L})(?:${languageNames})(?!\\p{L})`, 'iu').test(unquoted(question))
}
