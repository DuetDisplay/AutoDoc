import { ipcMain } from 'electron'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import type { OllamaManager } from '../services/ollama-manager'
import type { OllamaProvider } from '../services/llm'
import type { Transcript, MeetingSegments, CalendarEvent } from '../../shared/types'
import { decryptJSON, isEncrypted } from '../services/crypto'
import type { CalendarManager } from '../services/calendar-manager'
import { matchCalendarEvent, readMetadata } from '../services/calendar-matcher'

const CHAT_SYSTEM_PROMPT = `You are AutoDoc's AI assistant. You help users understand their meetings by answering questions based on meeting transcripts, notes, and their calendar.

Rules:
- Answer concisely and directly based on the meeting data provided
- If the answer isn't in the provided context, say so honestly
- Reference specific meetings when relevant
- Treat each "## Meeting" block as a separate meeting record
- Do not combine notes from one meeting with a different calendar event unless the title and date clearly match
- If a matching meeting says no transcript or notes are available, say that plainly instead of inferring details from another meeting
- Use plain language, not jargon`

const MAX_CHAT_MEETINGS = 5
const MAX_RELEVANCE_CANDIDATES = 12
const RECENT_CALENDAR_DAYS = 7
const CALENDAR_TITLE_LOOKBACK_DAYS = 30
const QUESTION_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'and',
  'any',
  'are',
  'did',
  'for',
  'from',
  'get',
  'had',
  'happened',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'latest',
  'me',
  'meeting',
  'meetings',
  'my',
  'of',
  'on',
  'recent',
  'show',
  'summarize',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'this',
  'those',
  'to',
  'was',
  'week',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
])

interface MeetingCandidate {
  id: string
  date: number
  dir: string
  title: string
  calendarTitle: string | null
}

interface MeetingSummary {
  body: string | null
  searchText: string
}

export function registerChatIpc(
  recordingsBaseDir: string,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
  calendarManager: CalendarManager,
): void {
  ipcMain.handle('chat:send', async (_event, question: string): Promise<string> => {
    // Try waiting for managed Ollama; fall back if server is already running externally
    try {
      await ollamaManager.waitUntilReady()
    } catch {
      const running = await ollamaManager.isServerRunning()
      if (!running) throw new Error('Ollama is not running. Please start Ollama and try again.')
    }

    const { recentEvents, upcomingEvents } = await loadCalendarContextData(calendarManager)

    // Gather context from relevant meetings and calendar
    const [meetingContext, calendarContext] = await Promise.all([
      gatherMeetingContext(recordingsBaseDir, question, recentEvents),
      Promise.resolve(formatCalendarContext(recentEvents, upcomingEvents, question)),
    ])

    const context = [meetingContext, calendarContext].filter(Boolean).join('\n\n---\n\n')

    const res = await fetch(`${ollamaManager.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaProvider.getModel(),
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Here is context from the user's calendar and recent meetings:\n\n${context}\n\n---\n\nUser question: ${question}`,
          },
        ],
        stream: false,
      }),
    })

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}`)
    }

    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? 'No response from AI.'
  })
}

async function gatherMeetingContext(
  recordingsBaseDir: string,
  question: string,
  recentEvents: CalendarEvent[],
): Promise<string> {
  let dirs: string[]
  try {
    dirs = await readdir(recordingsBaseDir)
  } catch {
    return 'No meetings found.'
  }

  const meetings: MeetingCandidate[] = []
  for (const meetingId of dirs) {
    const meetingDir = join(recordingsBaseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    const primaryStat =
      await stat(join(meetingDir, 'mic.webm')).catch(() => null) ??
      await stat(join(meetingDir, 'system.webm')).catch(() => null) ??
      await stat(join(meetingDir, 'audio.webm')).catch(() => null) ??
      await stat(join(meetingDir, 'transcript.json')).catch(() => null) ??
      await stat(join(meetingDir, 'segments.json')).catch(() => null)

    if (!primaryStat) continue

    const metadata = await readMetadata(meetingDir)
    const startedAt = metadata?.startedAt ?? primaryStat.birthtime.getTime()
    const createdAt = new Date(startedAt)
    const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    const calendarEvent = matchCalendarEvent(recentEvents, startedAt)

    const sourceName = metadata?.sourceName?.trim() || null
    const calendarTitle = calendarEvent?.title ?? null

    const title = metadata?.customTitle
      ? metadata.customTitle
      : sourceName && hasMeaningfulSourceName(sourceName)
        ? `${sourceName} — ${dateSuffix}`
        : calendarTitle
          ? `${calendarTitle} — ${dateSuffix}`
          : sourceName
            ? `${sourceName} — ${dateSuffix}`
            : `Recording ${dateSuffix}`

    meetings.push({ id: meetingId, date: startedAt, dir: meetingDir, title, calendarTitle })
  }

  meetings.sort((a, b) => b.date - a.date)

  const selectedMeetings = await selectMeetingsForQuestion(meetings, question)
  const contextParts: string[] = []
  for (const meeting of selectedMeetings) {
    const dateStr = new Date(meeting.date).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })

    const summary = await loadMeetingSummary(meeting.dir)
    let meetingContext = `## Meeting: ${meeting.title}\nDate: ${dateStr}\n`
    if (meeting.calendarTitle && !meeting.title.includes(meeting.calendarTitle)) {
      meetingContext += `Calendar match: ${meeting.calendarTitle}\n`
    }
    if (summary.body) {
      meetingContext += `\n${summary.body}`
    } else {
      meetingContext += '\nNo transcript or meeting notes are available for this meeting yet.'
    }

    contextParts.push(meetingContext)
  }

  return contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : 'No meeting data available.'
}

async function loadCalendarContextData(calendarManager: CalendarManager): Promise<{
  recentEvents: CalendarEvent[]
  upcomingEvents: CalendarEvent[]
}> {
  try {
    const [recentEvents, upcomingEvents] = await Promise.all([
      calendarManager.fetchAllRecentEvents(CALENDAR_TITLE_LOOKBACK_DAYS),
      calendarManager.fetchAllUpcomingEvents(),
    ])
    return { recentEvents, upcomingEvents }
  } catch {
    return { recentEvents: [], upcomingEvents: [] }
  }
}

function formatCalendarContext(
  recentEvents: CalendarEvent[],
  upcomingEvents: CalendarEvent[],
  question: string,
): string {
  const now = new Date()
  const recentCutoff = now.getTime() - RECENT_CALENDAR_DAYS * 24 * 60 * 60 * 1000
  const recentEventsForContext = filterCalendarEventsForQuestionWindow(
    recentEvents.filter((event) => event.startTime >= recentCutoff),
    question,
  )
  const upcomingEventsForContext = filterCalendarEventsByQuestionRelevance(upcomingEvents, question)

  const formatEventLine = (event: CalendarEvent): string => {
    const start = new Date(event.startTime)
    const end = new Date(event.endTime)
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    const timeStr = `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    const attendeeStr = event.attendees.length > 0 ? ` (with ${event.attendees.join(', ')})` : ''
    return `- ${dateStr}, ${timeStr}: ${event.title}${attendeeStr}`
  }

  const sections: string[] = []
  if (recentEventsForContext.length > 0) {
    sections.push(`## Recent Calendar Events\n${recentEventsForContext.map(formatEventLine).join('\n')}`)
  }
  if (upcomingEventsForContext.length > 0) {
    sections.push(`## Upcoming Calendar Events\n${upcomingEventsForContext.map(formatEventLine).join('\n')}`)
  }

  if (sections.length === 0) return ''

  return `Calendar reference (as of ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})\n\n${sections.join('\n\n')}`
}

async function selectMeetingsForQuestion(
  meetings: MeetingCandidate[],
  question: string,
): Promise<MeetingCandidate[]> {
  const windowedMeetings = filterMeetingsForQuestionWindow(meetings, question)
  const poolSource = windowedMeetings.length > 0 ? windowedMeetings : meetings
  const titleRanked = sortMeetingsByQuestion(poolSource, question)
  const candidatePool = titleRanked.slice(0, MAX_RELEVANCE_CANDIDATES)

  const meetingsWithSummaries = await Promise.all(
    candidatePool.map(async (meeting) => {
      const summary = await loadMeetingSummary(meeting.dir)
      return { ...meeting, summary }
    }),
  )

  const fullyRanked = [...meetingsWithSummaries].sort((a, b) => {
    const aScore = scoreMeetingRelevance(a.title, question, a.summary.searchText)
    const bScore = scoreMeetingRelevance(b.title, question, b.summary.searchText)
    if (aScore !== bScore) return bScore - aScore
    return b.date - a.date
  })

  const relevantMeetings = fullyRanked.filter(
    (meeting) => scoreMeetingRelevance(meeting.title, question, meeting.summary.searchText) > 0,
  )

  const selected = (relevantMeetings.length > 0 ? relevantMeetings : fullyRanked).slice(
    0,
    MAX_CHAT_MEETINGS,
  )

  return selected.map(({ summary: _summary, ...meeting }) => meeting)
}

async function loadMeetingSummary(meetingDir: string): Promise<MeetingSummary> {
  try {
    const sPath = join(meetingDir, 'segments.json')
    const segments: MeetingSegments = await isEncrypted(sPath)
      ? await decryptJSON<MeetingSegments>(sPath)
      : JSON.parse(await readFile(sPath, 'utf-8'))

    let body = ''
    let searchText = ''
    for (const [category, items] of Object.entries(segments)) {
      if (items.length === 0) continue
      body += `\n### ${category}\n`
      for (const item of items) {
        body += `- **${item.title}**: ${item.content}\n`
        searchText += ` ${item.topic ?? ''} ${item.title} ${item.content}`
      }
    }

    if (body.trim()) {
      return { body: body.trim(), searchText }
    }
  } catch {
    // Fall through to transcript fallback
  }

  try {
    const tPath = join(meetingDir, 'transcript.json')
    const transcripts: Transcript[] = await isEncrypted(tPath)
      ? await decryptJSON<Transcript[]>(tPath)
      : JSON.parse(await readFile(tPath, 'utf-8'))
    const text = transcripts.map((t) => t.text).join(' ')
    return {
      body: text.slice(0, 2000) + (text.length > 2000 ? '...' : ''),
      searchText: text,
    }
  } catch {
    return { body: null, searchText: '' }
  }
}

function filterMeetingsForQuestionWindow(
  meetings: MeetingCandidate[],
  question: string,
): MeetingCandidate[] {
  const normalizedQuestion = normalizeSearchText(question)
  if (!normalizedQuestion) return meetings

  const now = new Date()
  if (normalizedQuestion.includes('today')) {
    const today = now.toDateString()
    return meetings.filter((meeting) => new Date(meeting.date).toDateString() === today)
  }

  if (normalizedQuestion.includes('yesterday')) {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const yesterdayKey = yesterday.toDateString()
    return meetings.filter((meeting) => new Date(meeting.date).toDateString() === yesterdayKey)
  }

  if (normalizedQuestion.includes('this week')) {
    const startOfWeek = new Date(now)
    const day = startOfWeek.getDay()
    const diffToMonday = day === 0 ? 6 : day - 1
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday)
    startOfWeek.setHours(0, 0, 0, 0)
    return meetings.filter((meeting) => meeting.date >= startOfWeek.getTime())
  }

  if (normalizedQuestion.includes('this month')) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    return meetings.filter((meeting) => meeting.date >= startOfMonth.getTime())
  }

  return meetings
}

function filterCalendarEventsForQuestionWindow(
  events: CalendarEvent[],
  question: string,
): CalendarEvent[] {
  const normalizedQuestion = normalizeSearchText(question)
  if (!normalizedQuestion) return filterCalendarEventsByQuestionRelevance(events, question)

  const now = new Date()
  let windowedEvents = events

  if (normalizedQuestion.includes('today')) {
    const today = now.toDateString()
    windowedEvents = events.filter((event) => new Date(event.startTime).toDateString() === today)
  } else if (normalizedQuestion.includes('yesterday')) {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const yesterdayKey = yesterday.toDateString()
    windowedEvents = events.filter(
      (event) => new Date(event.startTime).toDateString() === yesterdayKey,
    )
  } else if (normalizedQuestion.includes('this week')) {
    const startOfWeek = new Date(now)
    const day = startOfWeek.getDay()
    const diffToMonday = day === 0 ? 6 : day - 1
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday)
    startOfWeek.setHours(0, 0, 0, 0)
    windowedEvents = events.filter((event) => event.startTime >= startOfWeek.getTime())
  } else if (normalizedQuestion.includes('this month')) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    windowedEvents = events.filter((event) => event.startTime >= startOfMonth.getTime())
  }

  return filterCalendarEventsByQuestionRelevance(windowedEvents, question)
}

function filterCalendarEventsByQuestionRelevance(
  events: CalendarEvent[],
  question: string,
): CalendarEvent[] {
  const ranked = [...events].sort((a, b) => {
    const aScore = scoreTextRelevance(`${a.title} ${a.attendees.join(' ')}`, question)
    const bScore = scoreTextRelevance(`${b.title} ${b.attendees.join(' ')}`, question)
    if (aScore !== bScore) return bScore - aScore
    return b.startTime - a.startTime
  })

  const relevant = ranked.filter(
    (event) => scoreTextRelevance(`${event.title} ${event.attendees.join(' ')}`, question) > 0,
  )

  return relevant.length > 0 ? relevant : ranked
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasMeaningfulSourceName(sourceName: string): boolean {
  const normalized = normalizeSearchText(sourceName)
  return normalized !== '' && ![
    'entire screen',
    'screen 1',
    'screen 2',
    'best quality current',
    'fast',
    'balanced',
    'quality',
  ].includes(normalized)
}

function extractQuestionPhrases(question: string): string[] {
  const normalizedQuestion = normalizeSearchText(question)
  if (!normalizedQuestion) return []

  const words = normalizedQuestion.split(' ').filter(Boolean)
  const phrases = new Set<string>()

  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`
    if (phrase.length < 6) continue
    if (QUESTION_STOP_WORDS.has(words[i]) && QUESTION_STOP_WORDS.has(words[i + 1])) continue
    phrases.add(phrase)
  }

  if (normalizedQuestion.includes('standup')) {
    phrases.add('standup')
  }

  return [...phrases]
}

export function extractQuestionTerms(question: string): string[] {
  const normalizedQuestion = normalizeSearchText(question)
  if (!normalizedQuestion) return []

  return [...new Set(
    normalizedQuestion
      .split(' ')
      .filter((term) => term.length >= 3 && !QUESTION_STOP_WORDS.has(term)),
  )]
}

export function scoreTextRelevance(text: string, question: string): number {
  const normalizedText = normalizeSearchText(text)
  if (!normalizedText) return 0

  const terms = extractQuestionTerms(question)
  const phrases = extractQuestionPhrases(question)
  let score = 0

  for (const phrase of phrases) {
    if (normalizedText.includes(phrase)) score += 5
  }

  for (const term of terms) {
    if (normalizedText.includes(term)) score += 2
  }

  return score
}

export function scoreMeetingRelevance(title: string, question: string, content = ''): number {
  return scoreTextRelevance(title, question) * 4 + scoreTextRelevance(content, question)
}

export function sortMeetingsByQuestion<T extends { title: string; date: number; searchText?: string | null }>(
  meetings: T[],
  question: string,
): T[] {
  return [...meetings].sort((a, b) => {
    const aScore = scoreMeetingRelevance(a.title, question, a.searchText ?? '')
    const bScore = scoreMeetingRelevance(b.title, question, b.searchText ?? '')
    if (aScore !== bScore) return bScore - aScore
    return b.date - a.date
  })
}
