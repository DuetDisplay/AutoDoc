import {
  extractQuestionTerms,
  hasQuestionWindowCue,
  isLatestRecordingQuery
} from './chat-retrieval'
import { normalizeRecordingSearchText } from './recording-title'
import { nativeInventoryIntent } from './ask-ai-inventory-intent'

export type AskAiSource = 'recordings' | 'calendar'

export type AskAiAct = 'count' | 'list' | 'latest' | 'actions' | 'compare' | 'calendar' | 'content'

export interface AskAiQuery {
  question: string
  source: AskAiSource
  act: AskAiAct
  topicTerms: string[]
  hasTimeWindow: boolean
}

/**
 * Words that describe the question, never the meeting content.
 * Time windows filter meeting.date. Speech/inventory words choose an act.
 * Whatever is left after this set is the topic (or a meeting title).
 */
const SCAFFOLDING = new Set([
  'about',
  'across',
  'any',
  'anyone',
  'anything',
  'around',
  'ask',
  'asked',
  'calendar',
  'calling',
  'come',
  'compare',
  'compared',
  'comparing',
  'comparison',
  'contrast',
  'comes',
  'coming',
  'cover',
  'covered',
  'covering',
  'did',
  'differ',
  'difference',
  'discuss',
  'discussed',
  'discussing',
  'do',
  'does',
  'during',
  'ever',
  'never',
  'always',
  'actually',
  'really',
  'already',
  'still',
  'just',
  'yet',
  'everybody',
  'everyone',
  'follow',
  'from',
  'go',
  'goes',
  'going',
  'had',
  'happen',
  'happened',
  'happening',
  'has',
  'have',
  'into',
  'item',
  'items',
  'last',
  'latest',
  'list',
  'mention',
  'mentioned',
  'mentioning',
  'month',
  'months',
  'most',
  'much',
  'need',
  'newest',
  'note',
  'notes',
  'number',
  'please',
  'action',
  'actions',
  'recent',
  'recap',
  'recapped',
  'record',
  'recorded',
  'recording',
  'recordings',
  'say',
  'said',
  'says',
  'show',
  'someone',
  'somebody',
  'schedule',
  'scheduled',
  'something',
  'step',
  'steps',
  'stuff',
  'task',
  'tasks',
  'todo',
  'todos',
  'summarize',
  'summarized',
  'summary',
  'talk',
  'talked',
  'talking',
  'tell',
  'telling',
  'there',
  'these',
  'this',
  'those',
  'today',
  'tomorrow',
  'told',
  'touch',
  'touched',
  'upcoming',
  'versus',
  'week',
  'weeks',
  'went',
  'were',
  'what',
  'which',
  'year',
  'years',
  'yesterday'
])

const CLOSED_SYNONYMS: Array<[string, string]> = [
  ['lag', 'latency'],
  ['latency', 'lag'],
  ['rdp', 'remote desktop'],
  ['remote desktop', 'rdp']
]

export function parseAskAiQuestion(question: string): AskAiQuery {
  const trimmed = question.trim()
  const normalized = normalizeRecordingSearchText(trimmed)
  const topicTerms = extractQuestionTerms(trimmed).filter((term) => !SCAFFOLDING.has(term))
  const hasTimeWindow = hasQuestionWindowCue(trimmed)
  const source: AskAiSource = isExplicitCalendarQuestion(trimmed) ? 'calendar' : 'recordings'
  const inventoryAct = nativeInventoryIntent(trimmed)
  if (inventoryAct)
    return {
      question: trimmed,
      source: 'recordings',
      act: inventoryAct,
      topicTerms: [],
      hasTimeWindow: false
    }

  let act: AskAiAct
  if (source === 'calendar') act = 'calendar'
  else if (isCompareQuestion(normalized)) act = 'compare'
  else if (isActionItemQuestion(normalized)) act = 'actions'
  else if (isCountQuestion(normalized) && topicTerms.length === 0) act = 'count'
  else if (isLatestRecordingQuery(trimmed)) act = 'latest'
  else if (topicTerms.length === 0) act = 'list'
  else act = 'content'

  return { question: trimmed, source, act, topicTerms, hasTimeWindow }
}

export function isExplicitCalendarQuestion(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return (
    /\b(calendar|schedule|scheduled|upcoming|tomorrow)\b/.test(normalized) ||
    /\bnext meeting\b/.test(normalized)
  )
}

export function expandQuestionWithSynonyms(question: string): string {
  const normalized = normalizeRecordingSearchText(question)
  const extras: string[] = []
  for (const [from, to] of CLOSED_SYNONYMS) {
    if (normalized.includes(from)) extras.push(to)
  }
  return extras.length > 0 ? `${question} ${extras.join(' ')}` : question
}

export function titleAbsorbsTopic(title: string, topicTerms: string[]): boolean {
  if (topicTerms.length === 0) return false
  return hasAllTopicTerms(title, topicTerms)
}

export function hasAllTopicTerms(text: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((term) => termSatisfied(text, term))
}

export function hasAnyTopicTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => termSatisfied(text, term))
}

export function formatTopicLabel(question: string, terms: string[]): string {
  const words = question.split(/\s+/).filter(Boolean)
  return terms
    .map((term) => {
      const original = words.find((word) => normalizeRecordingSearchText(word) === term)
      if (original) return original.replace(/[^A-Za-z0-9]/g, '')
      return term.length <= 4 ? term.toUpperCase() : term
    })
    .join(', ')
}

export function questionWindowLabel(question: string): string | null {
  const normalized = normalizeRecordingSearchText(question)
  if (normalized.includes('today')) return 'from today'
  if (normalized.includes('yesterday')) return 'from yesterday'
  if (/\bthis weeks?\b/.test(normalized)) return 'from this week'
  if (normalized.includes('last week')) return 'from last week'
  if (/\bthis months?\b/.test(normalized)) return 'from this month'
  if (normalized.includes('last month')) return 'from last month'
  return null
}

function termSatisfied(text: string, term: string): boolean {
  if (hasWord(text, term)) return true
  for (const [from, to] of CLOSED_SYNONYMS) {
    if (from === term && hasWord(text, to)) return true
  }
  return false
}

function hasWord(text: string, term: string): boolean {
  const normalized = normalizeRecordingSearchText(text)
  if (!normalized || !term) return false
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(normalized)
}

function isCompareQuestion(normalized: string): boolean {
  return /\b(compare|compared|comparing|comparison|contrast|versus|vs|difference|differ)\b/.test(
    normalized
  )
}

function isActionItemQuestion(normalized: string): boolean {
  return /\b(action items?|actions?|tasks?|todos?|next steps?|follow ups?)\b/.test(normalized)
}

function isCountQuestion(normalized: string): boolean {
  return (
    /\b(how many|count|number of)\b/.test(normalized) &&
    /\b(recordings?|meetings?)\b/.test(normalized)
  )
}
