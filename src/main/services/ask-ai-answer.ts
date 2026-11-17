import type { AskAiConversation } from './ask-ai-conversation'
import type { CalendarEvent } from '../../shared/types'
import { numberSourceCards, type ChatSourceCard } from './ask-ai-citations'
import {
  filterMeetingsForQuestionWindow,
  hasQuestionWindowCue,
  scoreTextRelevance,
  type ChatClarificationOption
} from './chat-retrieval'
import { classifyChatTurn, isEvidenceRecheck, type ChatTurnSession } from './chat-turn-classifier'
import type { IndexedMeeting, MeetingIndexService, MeetingInventoryItem } from './meeting-index'
import type { NotesV2SearchEntry } from './notes-search-text'
import { normalizeRecordingSearchText } from './recording-title'
import {
  expandQuestionWithSynonyms,
  formatTopicLabel,
  hasAllTopicTerms,
  hasAnyTopicTerm,
  isExplicitCalendarQuestion,
  parseAskAiQuestion,
  questionWindowLabel,
  titleAbsorbsTopic,
  type AskAiQuery
} from './ask-ai-query'

export type AskAiIntent =
  | 'acknowledgement'
  | 'smalltalk'
  | 'unsupported'
  | 'count_confirmation'
  | 'calendar'
  | 'count'
  | 'list'
  | 'summary'
  | 'lookup'
  | 'actions'
  | 'compare'
  | 'clarify'
  | 'no_notes'
  | 'no_match'

export interface AskAiSession {
  lastCalendarEvents: CalendarEvent[]
  lastRecordingIds: string[]
  lastRecordingTitles: string[]
  focusedRecordingIds: string[]
  lastClarificationOptions: ChatClarificationOption[]
  lastEvidenceRecordingIds?: string[]
  primaryMeetingIds?: string[]
}

export interface AskAiExcerpt {
  passageId?: string
  meetingId: string
  title: string
  date: number
  kind: 'note' | 'transcript'
  text: string
}

export interface AskAiAnswer {
  primaryMeetingIds?: string[]
  retrievalConfidence?: { score: number; margin: number; lexicalAnchor: number; confident: boolean }
  conversation?: AskAiConversation
  alreadyLocalized?: boolean
  /** The renderer shows "Search all meetings" on this clarification; it re-asks unscoped. */
  offerSearchAll?: boolean
  recheck?: { question: string; priorAnswer: string }
  intent: AskAiIntent
  content: string
  sources?: ChatSourceCard[]
  excerpts?: AskAiExcerpt[]
  clarificationOptions?: ChatClarificationOption[]
  selectedMeetingIds: string[]
  selectedTitles: string[]
  calendarEvents?: CalendarEvent[]
}

export interface AskAiMeetingStore {
  ensureLoaded(): Promise<void>
  listInventory(): Promise<MeetingInventoryItem[]>
  listMeetings(): Promise<IndexedMeeting[]>
  getMeeting(meetingId: string): Promise<IndexedMeeting | null>
}

export interface AskAiCalendar {
  fetchRecent(): Promise<CalendarEvent[]>
  fetchUpcoming(): Promise<CalendarEvent[]>
}

const LIST_CAP = 10
const LOOKUP_MEETING_CAP = 3
const LOOKUP_BULLET_CAP = 4
const ACTION_MEETING_CAP = 8
const ACTION_ITEM_CAP = 25
const COMPARE_MEETING_CAP = 3
const TRANSCRIPT_QUOTE_CHARS = 280
const TITLE_SCORE_THRESHOLD = 4
const GENERIC_TITLE = /^(recording\b|entire screen\b)/i

export function createAskAiSession(): AskAiSession {
  return {
    lastCalendarEvents: [],
    lastRecordingIds: [],
    lastRecordingTitles: [],
    focusedRecordingIds: [],
    lastEvidenceRecordingIds: [],
    lastClarificationOptions: []
  }
}

export { expandQuestionWithSynonyms, isExplicitCalendarQuestion, parseAskAiQuestion }

export async function answerQuestion(params: {
  question: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  session: AskAiSession
  store: AskAiMeetingStore
  calendar?: AskAiCalendar
  scopedMeetingIds?: string[]
  signal?: AbortSignal
}): Promise<AskAiAnswer> {
  throwIfAborted(params.signal)
  const question = params.question.trim()
  const history = params.history ?? []
  const session = params.session

  if (detectsUnsupportedActionRequest(normalizeRecordingSearchText(question))) {
    return conversational('unsupported', buildUnsupportedActionAnswer())
  }

  const turn = classifyChatTurn(question, history, toClassifierSession(session))
  if (
    isEvidenceRecheck(normalizeRecordingSearchText(question)) &&
    history.length === 0 &&
    !session.lastEvidenceRecordingIds?.length
  )
    return conversational(
      'clarify',
      'There is no prior answer to recheck in this chat. Which meeting or claim should I verify?'
    )
  if (turn.kind === 'acknowledgement') {
    return conversational('acknowledgement', "You're welcome.")
  }
  if (turn.kind === 'smalltalk') {
    return conversational('smalltalk', buildSmalltalkAnswer(turn.topic))
  }
  if (turn.kind === 'count_confirmation') {
    const actualCount =
      turn.scope === 'calendar'
        ? session.lastCalendarEvents.length
        : session.lastRecordingIds.length
    return conversational(
      'count_confirmation',
      formatCountConfirmation({
        label: turn.scope === 'calendar' ? 'calendar meeting' : 'local recording',
        actualCount,
        referencedCount: turn.referencedCount
      })
    )
  }

  await params.store.ensureLoaded()
  throwIfAborted(params.signal)
  const inventory = await params.store.listInventory()
  const meetings = await params.store.listMeetings()
  const priorQuestion =
    turn.kind === 'scoped_followup' && isEvidenceRecheck(normalizeRecordingSearchText(question))
      ? [...history]
          .reverse()
          .find(
            (message) =>
              message.role === 'user' &&
              !isEvidenceRecheck(normalizeRecordingSearchText(message.content)) &&
              !['acknowledgement', 'smalltalk', 'count_confirmation'].includes(
                classifyChatTurn(message.content, history, toClassifierSession(session)).kind
              )
          )
      : undefined
  const priorAnswer = priorQuestion
    ? history
        .slice(history.indexOf(priorQuestion) + 1)
        .find((message) => message.role === 'assistant')?.content
    : undefined
  const recheck =
    priorQuestion && priorAnswer ? { question: priorQuestion.content, priorAnswer } : undefined
  const query = parseAskAiQuestion(recheck?.question ?? question)
  const scopedIds = params.scopedMeetingIds?.length
    ? params.scopedMeetingIds
    : turn.kind === 'reference' || turn.kind === 'scoped_followup'
      ? turn.meetingIds
      : undefined

  if (scopedIds && scopedIds.length > 0) {
    return { ...(await answerScoped(query, scopedIds, meetings, inventory)), recheck }
  }
  return answerFromQuery(query, meetings, inventory, params.calendar)
}

function answerFromQuery(
  query: AskAiQuery,
  meetings: IndexedMeeting[],
  inventory: MeetingInventoryItem[],
  calendar?: AskAiCalendar
): AskAiAnswer | Promise<AskAiAnswer> {
  const windowedInventory = applyQuestionWindow(inventory, query.question)
  const windowedMeetings = applyQuestionWindow(meetings, query.question)

  switch (query.act) {
    case 'calendar':
      return answerCalendar(query.question, calendar)
    case 'count':
      return formatCount(windowedInventory, query)
    case 'list':
      return formatRecordingList(windowedInventory, query.question)
    case 'latest': {
      const latest = inventory[0]
      if (!latest) {
        return {
          intent: 'no_match',
          content: 'You do not have any recordings yet.',
          selectedMeetingIds: [],
          selectedTitles: []
        }
      }
      return formatMeetingSummary(latest, meetings)
    }
    case 'actions':
      return formatActionItems(query.hasTimeWindow ? windowedMeetings : meetings)
    case 'compare':
      return formatCompare(query.question, windowedMeetings, windowedInventory)
    case 'content':
      return answerContent(query, windowedMeetings, windowedInventory)
  }
}

/** Whole-library count/list from the authoritative inventory; no retrieval or model call. */
export function answerInventoryIntent(
  act: 'count' | 'list',
  question: string,
  inventory: MeetingInventoryItem[]
): AskAiAnswer {
  return act === 'count'
    ? formatCount(inventory, parseAskAiQuestion(question))
    : formatRecordingList(inventory, question)
}

export function applyAskAiAnswerToSession(session: AskAiSession, answer: AskAiAnswer): void {
  if (!['acknowledgement', 'smalltalk'].includes(answer.intent))
    session.lastEvidenceRecordingIds = [
      ...new Set((answer.sources ?? []).map((source) => source.meetingId))
    ]
  if (answer.calendarEvents) {
    session.lastCalendarEvents = answer.calendarEvents
  }
  if (
    answer.selectedMeetingIds.length > 0 &&
    (answer.intent === 'count' ||
      answer.intent === 'list' ||
      answer.intent === 'clarify' ||
      answer.intent === 'no_match')
  ) {
    session.lastRecordingIds = answer.selectedMeetingIds
    session.lastRecordingTitles = answer.selectedTitles
  }
  if (answer.selectedMeetingIds.length > 0) {
    session.focusedRecordingIds = answer.selectedMeetingIds
  }
  session.lastClarificationOptions = answer.clarificationOptions ?? []
}

function conversational(intent: AskAiIntent, content: string): AskAiAnswer {
  return { intent, content, selectedMeetingIds: [], selectedTitles: [] }
}

async function answerCalendar(question: string, calendar?: AskAiCalendar): Promise<AskAiAnswer> {
  if (!calendar) {
    return {
      intent: 'calendar',
      content: 'I could not refresh your calendar right now, so I cannot list those meetings.',
      selectedMeetingIds: [],
      selectedTitles: []
    }
  }
  const [recentEvents, upcomingEvents] = await Promise.all([
    calendar.fetchRecent(),
    calendar.fetchUpcoming()
  ])
  const upcoming = isUpcomingCalendarQuestion(question)
  const events = upcoming
    ? upcomingEvents.slice().sort((a, b) => a.startTime - b.startTime)
    : recentEvents.slice().sort((a, b) => b.startTime - a.startTime)
  if (events.length === 0) {
    return {
      intent: 'calendar',
      content: upcoming
        ? 'I did not find any upcoming calendar meetings.'
        : 'I did not find any calendar meetings recently.',
      selectedMeetingIds: [],
      selectedTitles: [],
      calendarEvents: events
    }
  }
  const lines = events.slice(0, 20).map((event) => {
    const start = new Date(event.startTime)
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
    const timeStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    return `- ${dateStr}, ${timeStr}: ${event.title}`
  })
  const label = upcoming ? 'upcoming calendar meeting' : 'calendar meeting'
  return {
    intent: 'calendar',
    content: `I found ${events.length} ${label}${events.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`,
    selectedMeetingIds: [],
    selectedTitles: [],
    calendarEvents: events
  }
}

function formatCount(inventory: MeetingInventoryItem[], query: AskAiQuery): AskAiAnswer {
  const windowLabel = questionWindowLabel(query.question)
  return {
    intent: 'count',
    content: windowLabel
      ? `You have ${inventory.length} recording${inventory.length === 1 ? '' : 's'} ${windowLabel}.`
      : `You have ${inventory.length} recording${inventory.length === 1 ? '' : 's'}.`,
    selectedMeetingIds: inventory.map((item) => item.meetingId),
    selectedTitles: inventory.map((item) => item.title)
  }
}

function answerContent(
  query: AskAiQuery,
  meetings: IndexedMeeting[],
  inventory: MeetingInventoryItem[]
): AskAiAnswer {
  const titleMatches = rankTitleMatches(query.question, inventory)
  const absorbed = titleMatches.filter((match) =>
    titleAbsorbsTopic(`${match.item.title} ${match.item.sourceName ?? ''}`, query.topicTerms)
  )
  const named = absorbed.length > 0 ? absorbed : []

  if (named.length >= 2 && (isAmbiguousTitleQuestion(query.question) || named[0]!.score < 12)) {
    return formatClarification(named.slice(0, 4), inventory)
  }
  if (named.length >= 1) {
    return formatMeetingSummary(named[0]!.item, meetings)
  }

  const lookup = formatNoteLookup(query, meetings)
  if (lookup) return lookup
  const transcript = formatTranscriptFallback(query, meetings)
  if (transcript) return transcript

  if (titleMatches.length >= 2 && isAmbiguousTitleQuestion(query.question)) {
    return formatClarification(titleMatches.slice(0, 4), inventory)
  }

  return formatNoMatch(inventory, query)
}

async function answerScoped(
  query: AskAiQuery,
  meetingIds: string[],
  meetings: IndexedMeeting[],
  inventory: MeetingInventoryItem[]
): Promise<AskAiAnswer> {
  const scopedMeetings = meetingIds
    .map((id) => meetings.find((meeting) => meeting.meetingId === id))
    .filter((meeting): meeting is IndexedMeeting => meeting != null)
  const scopedInventory = meetingIds
    .map((id) => inventory.find((item) => item.meetingId === id))
    .filter((item): item is MeetingInventoryItem => item != null)

  if (scopedInventory.length === 0 && scopedMeetings.length === 0) {
    return formatNoMatch(inventory, query)
  }

  if (query.act === 'actions') {
    return formatActionItems(scopedMeetings.length > 0 ? scopedMeetings : meetings)
  }
  if (query.act === 'compare' && scopedMeetings.length >= 2) {
    return formatCompare(query.question, scopedMeetings, scopedInventory)
  }

  const lookup = formatNoteLookup(query, scopedMeetings)
  if (lookup) return lookup
  const transcript = formatTranscriptFallback(query, scopedMeetings)
  if (transcript) return transcript

  const first = scopedInventory[0] ?? inventoryItemFromMeeting(scopedMeetings[0]!)
  return formatMeetingSummary(first, meetings)
}

function formatRecordingList(inventory: MeetingInventoryItem[], question?: string): AskAiAnswer {
  const windowLabel = question ? questionWindowLabel(question) : null
  if (inventory.length === 0) {
    return {
      intent: 'list',
      content: windowLabel
        ? `You do not have any recordings ${windowLabel}.`
        : 'You do not have any recordings yet.',
      selectedMeetingIds: [],
      selectedTitles: []
    }
  }
  const visible = inventory.slice(0, LIST_CAP)
  const lines = visible.map((item, index) => `${index + 1}. ${item.title}`)
  const heading = windowLabel
    ? `Here are your recordings ${windowLabel}:`
    : 'Here are your most recent recordings:'
  const close =
    inventory.length > visible.length
      ? `\n\nI found ${inventory.length} recordings total and showed the most recent ${visible.length}. Ask for a title or topic to narrow.`
      : `\n\nI found ${inventory.length} recording${inventory.length === 1 ? '' : 's'} total. Ask for a title or topic to narrow.`
  return {
    intent: 'list',
    content: `${heading}\n\n${lines.join('\n')}${close}`,
    selectedMeetingIds: visible.map((item) => item.meetingId),
    selectedTitles: visible.map((item) => item.title)
  }
}

function formatMeetingSummary(item: MeetingInventoryItem, meetings: IndexedMeeting[]): AskAiAnswer {
  const meeting = meetings.find((entry) => entry.meetingId === item.meetingId)
  const stamp = formatStamp(item.date)
  if (!meeting || meeting.noteEntries.length === 0) {
    return {
      intent: 'no_notes',
      content: `I have ${item.title} (${stamp}), but no notes yet.`,
      selectedMeetingIds: [item.meetingId],
      selectedTitles: [item.title]
    }
  }

  const overview = meeting.noteEntries.find((entry) => entry.id === 'overview')
  const takeaways = meeting.noteEntries.filter(
    (entry) => entry.id !== 'overview' && entry.category !== 'actionItems'
  )
  const nextSteps = meeting.noteEntries.filter((entry) => entry.category === 'actionItems')
  const parts = [`**${item.title}** (${stamp})`]
  if (overview) parts.push('', overview.content)
  if (takeaways.length > 0) {
    parts.push(
      '',
      '**Key takeaways**',
      ...takeaways.slice(0, 6).map((entry) => formatBullet(entry))
    )
  }
  if (nextSteps.length > 0) {
    parts.push('', '**Next steps**', ...nextSteps.slice(0, 4).map((entry) => formatBullet(entry)))
  }
  if (!overview && takeaways.length === 0 && nextSteps.length === 0) {
    parts.push('', ...meeting.noteEntries.slice(0, 6).map((entry) => formatBullet(entry)))
  }

  const excerptEntries = [
    ...(overview ? [overview] : []),
    ...takeaways.slice(0, 6),
    ...nextSteps.slice(0, 4)
  ]
  return {
    intent: 'summary',
    content: parts.join('\n'),
    sources: cardsFromEntries(item, meeting.noteEntries.slice(0, 8)),
    excerpts: excerptEntries.map((entry) =>
      excerptFromNote(item.meetingId, item.title, item.date, entry)
    ),
    selectedMeetingIds: [item.meetingId],
    selectedTitles: [item.title]
  }
}

function formatNoteLookup(query: AskAiQuery, meetings: IndexedMeeting[]): AskAiAnswer | null {
  const terms = query.topicTerms
  if (terms.length === 0) return null
  const windowed = applyQuestionWindow(meetings, query.question)
  return lookupNotesIn(query, terms, windowed)
}

function lookupNotesIn(
  query: AskAiQuery,
  terms: string[],
  meetings: IndexedMeeting[]
): AskAiAnswer | null {
  const expanded = terms.join(' ')
  const scored = meetings
    .map((meeting) => {
      const haystack = meeting.noteEntries.map((entry) => noteEntryText(entry)).join(' ')
      if (!hasAllTopicTerms(haystack, terms)) {
        return { meeting, hits: [], score: 0 }
      }
      const candidates = meeting.noteEntries
        .map((entry) => ({
          entry,
          score: scoreNoteEntry(entry, expanded)
        }))
        .filter((hit) => hit.score >= 2)
      const strictHits = candidates.filter((hit) =>
        hasAllTopicTerms(noteEntryText(hit.entry), terms)
      )
      const hits = (
        strictHits.length > 0
          ? strictHits
          : candidates.filter((hit) => hasAnyTopicTerm(noteEntryText(hit.entry), terms))
      )
        .sort((a, b) => b.score - a.score)
        .slice(0, LOOKUP_BULLET_CAP)
      const score = hits.reduce((sum, hit) => sum + hit.score, 0)
      return { meeting, hits, score }
    })
    .filter((row) => row.hits.length > 0)
    .sort((a, b) => b.score - a.score || b.meeting.date - a.meeting.date)

  const topScore = scored[0]?.score ?? 0
  const picked = scored.filter((row) => row.score >= topScore * 0.5).slice(0, LOOKUP_MEETING_CAP)

  if (picked.length === 0) return null

  const topic = formatTopicLabel(query.question, terms)
  const sections = picked.map(({ meeting, hits }) => {
    const stamp = formatStamp(meeting.date)
    const bullets = hits.map((hit) => formatBullet(hit.entry)).join('\n')
    return picked.length === 1
      ? `Yes — ${meeting.title} (${stamp}) mentions ${topic}:\n${bullets}`
      : `In ${meeting.title} (${stamp}):\n${bullets}`
  })
  const lead = picked.length > 1 ? `Yes — ${topic} shows up in ${picked.length} meetings.\n\n` : ''
  const sources = picked.flatMap(({ meeting, hits }) =>
    cardsFromEntries(
      inventoryItemFromMeeting(meeting),
      hits.map((hit) => hit.entry)
    )
  )

  return {
    intent: 'lookup',
    content: `${lead}${sections.join('\n\n')}`,
    sources,
    excerpts: picked.flatMap(({ meeting, hits }) =>
      hits.map((hit) => excerptFromNote(meeting.meetingId, meeting.title, meeting.date, hit.entry))
    ),
    selectedMeetingIds: picked.map((row) => row.meeting.meetingId),
    selectedTitles: picked.map((row) => row.meeting.title)
  }
}

function formatTranscriptFallback(
  query: AskAiQuery,
  meetings: IndexedMeeting[]
): AskAiAnswer | null {
  const terms = query.topicTerms
  if (terms.length === 0) return null
  const windowed = applyQuestionWindow(meetings, query.question)
  return lookupTranscriptsIn(query, terms, windowed)
}

function lookupTranscriptsIn(
  query: AskAiQuery,
  terms: string[],
  meetings: IndexedMeeting[]
): AskAiAnswer | null {
  const expanded = terms.join(' ')
  const scored = meetings
    .map((meeting) => {
      const haystack = meeting.transcriptChunks.map((chunk) => chunk.text).join(' ')
      if (!hasAllTopicTerms(haystack, terms)) {
        return { meeting, hits: [], score: 0 }
      }
      const hits = meeting.transcriptChunks
        .map((chunk) => ({
          chunk,
          score: scoreTextRelevance(chunk.text, expanded)
        }))
        .filter((hit) => hasAnyTopicTerm(hit.chunk.text, terms) && hit.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 1)
      return { meeting, hits, score: hits[0]?.score ?? 0 }
    })
    .filter((row) => row.hits.length > 0)
    .sort((a, b) => b.score - a.score || b.meeting.date - a.meeting.date)
    .slice(0, LOOKUP_MEETING_CAP)

  if (scored.length === 0) return null

  const topic = formatTopicLabel(query.question, terms)
  const sections = scored.map(({ meeting, hits }) => {
    const stamp = formatStamp(meeting.date)
    const quote = trimQuote(hits[0]!.chunk.text)
    return scored.length === 1
      ? `Yes — ${meeting.title} (${stamp}) mentions ${topic} in the transcript:\n> ${quote}`
      : `In ${meeting.title} (${stamp}), the transcript says:\n> ${quote}`
  })
  const lead = scored.length > 1 ? `Yes — ${topic} shows up in ${scored.length} meetings.\n\n` : ''
  const sources = numberSourceCards(
    scored.flatMap(({ meeting, hits }) =>
      hits.map((hit) => ({
        meetingId: meeting.meetingId,
        title: meeting.title,
        quote: trimQuote(hit.chunk.text),
        startMs: hit.chunk.startMs,
        category: 'transcript'
      }))
    )
  )

  return {
    intent: 'lookup',
    content: `${lead}${sections.join('\n\n')}`,
    sources,
    excerpts: scored.flatMap(({ meeting, hits }) =>
      hits.map((hit) => ({
        meetingId: meeting.meetingId,
        title: meeting.title,
        date: meeting.date,
        kind: 'transcript' as const,
        text: trimQuote(hit.chunk.text)
      }))
    ),
    selectedMeetingIds: scored.map((row) => row.meeting.meetingId),
    selectedTitles: scored.map((row) => row.meeting.title)
  }
}

function formatActionItems(meetings: IndexedMeeting[]): AskAiAnswer {
  const groups = meetings
    .map((meeting) => ({
      meeting,
      items: meeting.noteEntries.filter((entry) => isActionLike(entry))
    }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.meeting.date - a.meeting.date)
    .slice(0, ACTION_MEETING_CAP)

  if (groups.length === 0) {
    return {
      intent: 'actions',
      content: 'I did not find action items in your notes.',
      selectedMeetingIds: [],
      selectedTitles: []
    }
  }

  let remaining = ACTION_ITEM_CAP
  const sections: string[] = []
  const sourceEntries: Array<{ meeting: IndexedMeeting; entry: NotesV2SearchEntry }> = []
  for (const group of groups) {
    if (remaining <= 0) break
    const items = group.items.slice(0, remaining)
    remaining -= items.length
    sections.push(
      `From ${group.meeting.title} (${formatStamp(group.meeting.date)}):\n${items.map((entry) => formatBullet(entry)).join('\n')}`
    )
    for (const entry of items) sourceEntries.push({ meeting: group.meeting, entry })
  }
  const itemCount = sourceEntries.length
  const meetingCount = new Set(sourceEntries.map((row) => row.meeting.meetingId)).size

  return {
    intent: 'actions',
    content: `I found ${itemCount} action item${itemCount === 1 ? '' : 's'} in ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}.\n\n${sections.join('\n\n')}`,
    sources: numberSourceCards(
      sourceEntries.slice(0, 8).map(({ meeting, entry }) => ({
        meetingId: meeting.meetingId,
        title: meeting.title,
        quote: entry.content,
        startMs: entry.sources[0]?.startMs ?? null,
        category: entry.category
      }))
    ),
    excerpts: sourceEntries
      .slice(0, 12)
      .map(({ meeting, entry }) =>
        excerptFromNote(meeting.meetingId, meeting.title, meeting.date, entry)
      ),
    selectedMeetingIds: groups.map((group) => group.meeting.meetingId),
    selectedTitles: groups.map((group) => group.meeting.title)
  }
}

function formatCompare(
  question: string,
  meetings: IndexedMeeting[],
  inventory: MeetingInventoryItem[]
): AskAiAnswer {
  const resolved = resolveCompareMeetings(question, meetings, inventory)
  if (resolved.length < 2) {
    if (resolved.length === 1) return formatMeetingSummary(resolved[0]!, meetings)
    return formatNoMatch(inventory, parseAskAiQuestion(question))
  }

  const sections = resolved.slice(0, COMPARE_MEETING_CAP).map((item) => {
    const meeting = meetings.find((entry) => entry.meetingId === item.meetingId)
    const stamp = formatStamp(item.date)
    if (!meeting || meeting.noteEntries.length === 0) {
      return `**${item.title}** (${stamp})\n\nNo notes yet.`
    }
    const overview = meeting.noteEntries.find((entry) => entry.id === 'overview')
    const takeaways = meeting.noteEntries
      .filter((entry) => entry.id !== 'overview')
      .slice(0, 4)
      .map((entry) => formatBullet(entry))
    return [`**${item.title}** (${stamp})`, overview?.content, ...takeaways]
      .filter(Boolean)
      .join('\n')
  })
  const sources = resolved.flatMap((item) => {
    const meeting = meetings.find((entry) => entry.meetingId === item.meetingId)
    return meeting ? cardsFromEntries(item, meeting.noteEntries.slice(0, 3)) : []
  })

  const excerpts = resolved.flatMap((item) => {
    const meeting = meetings.find((entry) => entry.meetingId === item.meetingId)
    if (!meeting) return []
    return meeting.noteEntries
      .slice(0, 5)
      .map((entry) => excerptFromNote(item.meetingId, item.title, item.date, entry))
  })
  return {
    intent: 'compare',
    content: `Here's what each meeting's notes say:\n\n${sections.join('\n\n')}`,
    sources: sources.length > 0 ? sources : undefined,
    excerpts: excerpts.length > 0 ? excerpts : undefined,
    selectedMeetingIds: resolved.map((item) => item.meetingId),
    selectedTitles: resolved.map((item) => item.title)
  }
}

export function inventoryClarificationOptions(
  matches: Array<{ item: MeetingInventoryItem; score: number }>,
  inventory: MeetingInventoryItem[]
): ChatClarificationOption[] {
  return matches.map((match) => {
    const meeting = inventory.find((item) => item.meetingId === match.item.meetingId) ?? match.item
    return {
      meetingId: meeting.meetingId,
      title: meeting.title,
      subtitle: formatStamp(meeting.date),
      date: meeting.date,
      sourceName: meeting.sourceName,
      calendarTitle: null,
      slackChannel: null,
      participants: [],
      notePreview: null,
      score: match.score
    } satisfies ChatClarificationOption
  })
}

function formatClarification(
  matches: Array<{ item: MeetingInventoryItem; score: number }>,
  inventory: MeetingInventoryItem[]
): AskAiAnswer {
  const options = inventoryClarificationOptions(matches, inventory)
  const lines = options.map((option, index) => `${index + 1}. ${option.title} — ${option.subtitle}`)
  return {
    intent: 'clarify',
    content: `I found a few possible matching meetings. Which one should I use?\n\n${lines.join('\n')}\n\nIf none of these are right, tell me the date, time frame, title, person, or topic to search for.`,
    clarificationOptions: options,
    selectedMeetingIds: options.map((option) => option.meetingId),
    selectedTitles: options.map((option) => option.title)
  }
}

function formatNoMatch(inventory: MeetingInventoryItem[], query?: AskAiQuery): AskAiAnswer {
  const topic = query?.topicTerms.length
    ? formatTopicLabel(query.question, query.topicTerms).replace(/, /g, ' ')
    : null
  const window = query ? questionWindowLabel(query.question) : null
  const subject = topic ?? 'that'
  const where = window ? ` ${window}` : ''
  const hasNotes = inventory.some((item) => item.hasNotes)
  const content =
    hasNotes || window
      ? `I didn't find ${subject} in your notes or transcripts${where}.`
      : `I didn't find ${subject}, and none of your recordings have notes yet.`
  return {
    intent: 'no_match',
    content,
    selectedMeetingIds: [],
    selectedTitles: []
  }
}

function rankTitleMatches(
  question: string,
  inventory: MeetingInventoryItem[]
): Array<{ item: MeetingInventoryItem; score: number }> {
  const expanded = expandQuestionWithSynonyms(question)
  const ranked = inventory
    .map((item) => ({
      item,
      score: scoreTitle(item, expanded)
    }))
    .filter((row) => row.score >= TITLE_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score || b.item.date - a.item.date)

  const typeCue = normalizeRecordingSearchText(question).match(/\b(huddle|standup|sync)\b/)?.[1]
  if (!typeCue) return ranked
  const typed = ranked.filter((row) => {
    const title = normalizeRecordingSearchText(row.item.title).replace(/\bstand up\b/g, 'standup')
    return title.includes(typeCue)
  })
  return typed.length > 0 ? typed : ranked
}

function scoreTitle(item: MeetingInventoryItem, question: string): number {
  const visible = normalizeRecordingSearchText(item.title.replace(/\s+—\s+.*$/, ''))
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (visible.length >= 8 && normalizedQuestion.includes(visible)) return 16
  const visibleScore = visible.length >= 4 ? scoreTextRelevance(visible, question) : 0
  if (visibleScore >= TITLE_SCORE_THRESHOLD || !isGenericVisibleTitle(visible)) {
    return visibleScore
  }
  const source = normalizeRecordingSearchText(item.sourceName ?? '')
  if (source.length >= 8 && normalizedQuestion.includes(source)) return 16
  return source.length >= 4 ? scoreTextRelevance(source, question) : 0
}

function isGenericVisibleTitle(visible: string): boolean {
  return visible.length < 8 || GENERIC_TITLE.test(visible)
}

function resolveCompareMeetings(
  question: string,
  meetings: IndexedMeeting[],
  inventory: MeetingInventoryItem[]
): MeetingInventoryItem[] {
  const parts = normalizeRecordingSearchText(question).split(/\b(?:and|versus|vs|or)\b/)
  const resolved: MeetingInventoryItem[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const matches = rankTitleMatches(part, inventory)
    const pick = matches[0]?.item
    if (pick && !seen.has(pick.meetingId)) {
      seen.add(pick.meetingId)
      resolved.push(pick)
    }
  }
  if (resolved.length >= 2) return resolved
  return meetings.slice(0, COMPARE_MEETING_CAP).map(inventoryItemFromMeeting)
}

function scoreNoteEntry(entry: NotesV2SearchEntry, question: string): number {
  const text = [entry.title, entry.content, entry.topic, entry.owner, entry.deadline]
    .filter(Boolean)
    .join(' ')
  let score = scoreTextRelevance(text, question)
  if (entry.owner && normalizeRecordingSearchText(question).includes('owner')) score += 1
  if (entry.deadline && /\b(due|deadline)\b/.test(normalizeRecordingSearchText(question)))
    score += 1
  return score
}

function cardsFromEntries(
  item: MeetingInventoryItem,
  entries: NotesV2SearchEntry[]
): ChatSourceCard[] {
  return numberSourceCards(
    entries
      .filter((entry) => entry.sources[0]?.startMs != null)
      .map((entry) => ({
        meetingId: item.meetingId,
        title: item.title,
        quote: entry.content,
        startMs: entry.sources[0]?.startMs ?? null,
        category: entry.category
      }))
  )
}

function inventoryItemFromMeeting(meeting: IndexedMeeting): MeetingInventoryItem {
  return {
    meetingId: meeting.meetingId,
    title: meeting.title,
    date: meeting.date,
    sourceName: meeting.sourceName,
    hasNotes: meeting.noteEntries.length > 0,
    hasTranscript: meeting.transcriptChunks.length > 0
  }
}

function formatBullet(entry: NotesV2SearchEntry): string {
  const meta = [
    entry.owner ? `Owner: ${entry.owner}` : null,
    entry.deadline ? `Due: ${entry.deadline}` : null
  ]
    .filter(Boolean)
    .join('; ')
  const title = entry.title?.trim() ?? ''
  const content = entry.content.trim()
  const titleAlreadyInContent =
    title.length > 0 &&
    title !== 'Overview' &&
    normalizeRecordingSearchText(content).startsWith(normalizeRecordingSearchText(title))
  const text =
    title && title !== 'Overview' && !titleAlreadyInContent ? `${title}: ${content}` : content
  return meta ? `- ${text} (${meta})` : `- ${text}`
}

function formatStamp(date: number): string {
  const value = new Date(date)
  return `${value.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })}, ${value.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function trimQuote(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > TRANSCRIPT_QUOTE_CHARS
    ? `${cleaned.slice(0, TRANSCRIPT_QUOTE_CHARS - 1).trim()}…`
    : cleaned
}

function excerptFromNote(
  meetingId: string,
  title: string,
  date: number,
  entry: NotesV2SearchEntry
): AskAiExcerpt {
  return {
    meetingId,
    title,
    date,
    kind: 'note',
    text: formatBullet(entry).replace(/^- /, '')
  }
}

function noteEntryText(entry: NotesV2SearchEntry): string {
  return [entry.title, entry.content, entry.topic, entry.owner, entry.deadline]
    .filter(Boolean)
    .join(' ')
}

function applyQuestionWindow<T extends { date: number }>(items: T[], question: string): T[] {
  if (!hasQuestionWindowCue(question)) return items
  return filterMeetingsForQuestionWindow(items, question)
}

function isAmbiguousTitleQuestion(question: string): boolean {
  return /\b(huddle|standup|stand up|sync|call|meeting)\b/.test(
    normalizeRecordingSearchText(question)
  )
}

function isUpcomingCalendarQuestion(question: string): boolean {
  return /\b(upcoming|tomorrow|next meeting|schedule)\b/.test(
    normalizeRecordingSearchText(question)
  )
}

function isActionLike(entry: NotesV2SearchEntry): boolean {
  return (
    entry.category === 'actionItems' ||
    /\b(action|task|todo|follow up|next step|assigned|owner|due)\b/.test(
      `${entry.title} ${entry.content}`.toLowerCase()
    )
  )
}

function toClassifierSession(session: AskAiSession): ChatTurnSession {
  return {
    recordingIds: session.lastRecordingIds,
    recordingTitles: session.lastRecordingTitles,
    calendarEventCount: session.lastCalendarEvents.length,
    focusedRecordingIds: session.focusedRecordingIds,
    evidenceRecordingIds: session.lastEvidenceRecordingIds,
    lastTurnWasClarification: session.lastClarificationOptions.length > 0
  }
}

const UNSUPPORTED_ACTION_VERBS =
  /\b(schedule|reschedule|set up|setup|create|delete|remove|erase|cancel|email|e-?mail|invite|book)\b/
const READ_ONLY_LEAD =
  /\b(summar(?:y|ize|ise)|recap|tell|explain|describe|what|which|who|when|where|why|how|show|find|list|search|review|decide|decided|deciding|discuss|discussed|happened|cover|covered)\b/

export function detectsUnsupportedActionRequest(normalized: string): boolean {
  const actionMatch = UNSUPPORTED_ACTION_VERBS.exec(normalized)
  if (!actionMatch) return false
  const readLead = READ_ONLY_LEAD.exec(normalized)
  if (readLead && readLead.index < actionMatch.index) return false
  const requestFramed =
    /\b(can|could|would|will|please|able to|go ahead and|i need you to|i want you to)\b/.test(
      normalized
    )
  const imperativeLed = new RegExp(
    `^(?:hey |hi |ok |okay |so |please |could you |can you |would you |will you )*${UNSUPPORTED_ACTION_VERBS.source}`
  ).test(normalized)
  return requestFramed || imperativeLed
}

function buildUnsupportedActionAnswer(): string {
  return "I can't do that — I can only find, search, and summarize your recordings, notes, and calendar. I can't schedule, create, delete, send, or email anything. Want me to look something up instead?"
}

function buildSmalltalkAnswer(topic: 'greeting' | 'capability'): string {
  if (topic === 'capability') {
    return "I'm AutoDoc's meeting assistant. Ask me what was discussed in a meeting, who owns an action item, decisions and deadlines, or what's on your calendar — I'll answer from your local recordings and notes."
  }
  return 'Hi! Ask me anything about your meetings — what was discussed, your action items and owners, or what you have coming up on your calendar.'
}

function formatCountConfirmation(params: {
  label: string
  actualCount: number
  referencedCount: number | null
}): string {
  const pluralLabel = `${params.label}${params.actualCount === 1 ? '' : 's'}`
  if (params.referencedCount == null || params.referencedCount === params.actualCount) {
    return `Yes, you have ${params.actualCount} ${pluralLabel} in that list.`
  }
  return `Not quite - you have ${params.actualCount} ${pluralLabel} in that list.`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
}

export type { MeetingIndexService }
