import { describe, expect, it, vi } from 'vitest'
import {
  answerQuestion,
  applyAskAiAnswerToSession,
  createAskAiSession,
  expandQuestionWithSynonyms,
  isExplicitCalendarQuestion
} from '../ask-ai-answer'
import type { IndexedMeeting, MeetingInventoryItem } from '../meeting-index'
import type { NotesV2SearchEntry } from '../notes-search-text'

const HUDDLE_AUG = 'huddle-aug20'
const HUDDLE_MAY = 'huddle-may20'
const SQA = 'ts-sqa'
const LATENCY = 'latency-test'
it('does not invent a previous claim for an evidence challenge in a new chat', async () => {
  const answer = await answerQuestion({
    question: 'Are you sure? Show me the evidence.',
    session: createAskAiSession(),
    store: fakeStore([])
  })
  expect(answer.intent).toBe('clarify')
  expect(answer.sources).toBeUndefined()
  expect(answer.content).toContain('no prior answer')
})

it('rechecks Harbor evidence and the prior claim, then keeps the subsequent followup scoped', async () => {
  const meetings = [
    meeting({
      id: 'atlas',
      title: 'Atlas launch review',
      date: Date.UTC(2026, 9, 12),
      notes: [
        note('overview', 'Mira owns Atlas. The budget is $47,250. The launch is October 23, 2026.')
      ],
      transcript: [{ startMs: 30000, text: 'The emergency rollback passphrase is cedar falcon.' }]
    }),
    meeting({
      id: 'harbor',
      title: 'Harbor engineering review',
      date: Date.UTC(2026, 9, 12),
      notes: [
        note('overview', 'Jon owns Harbor. The budget is $18,600. The launch is December 4, 2026.')
      ]
    })
  ]
  const session = createAskAiSession()
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const store = fakeStore(meetings)
  for (const q of [
    'What is the Harbor budget?',
    'Who owns that service?',
    'When is that launch?'
  ]) {
    const answer = await answerQuestion({ question: q, history, session, store })
    applyAskAiAnswerToSession(session, answer)
    history.push({ role: 'user', content: q }, { role: 'assistant', content: answer.content })
  }
  const check = await answerQuestion({
    question: 'Are you sure? Show me the evidence.',
    history,
    session,
    store
  })
  expect(check.sources?.every((source) => source.meetingId === 'harbor')).toBe(true)
  expect(check.content).not.toContain('cedar falcon')
  expect(check.recheck?.question).toBe('When is that launch?')
  expect(check.recheck?.priorAnswer).toContain('December 4')
  applyAskAiAnswerToSession(session, check)
  history.push(
    { role: 'user', content: 'Are you sure? Show me the evidence.' },
    { role: 'assistant', content: check.content }
  )
  const next = await answerQuestion({
    question: 'What was its budget again?',
    history,
    session,
    store
  })
  expect(next.sources?.every((source) => source.meetingId === 'harbor')).toBe(true)
  expect(next.content).toContain('18,600')
  expect(next.content).not.toContain('47,250')
})
const STANDUP = 'standup'

function note(
  id: string,
  content: string,
  extras: Partial<NotesV2SearchEntry> = {}
): NotesV2SearchEntry {
  return {
    id,
    category: extras.category ?? 'information',
    title: extras.title ?? (id === 'overview' ? 'Overview' : 'Note'),
    content,
    topic: extras.topic ?? null,
    owner: extras.owner ?? null,
    deadline: extras.deadline ?? null,
    sources: extras.sources ?? [{ startMs: 1_000, endMs: 4_000 }]
  }
}

function meeting(params: {
  id: string
  title: string
  date: number
  sourceName?: string | null
  notes?: NotesV2SearchEntry[]
  transcript?: Array<{ startMs: number; text: string }>
}): IndexedMeeting {
  return {
    meetingId: params.id,
    title: params.title,
    date: params.date,
    dir: `/tmp/${params.id}`,
    sourceName: params.sourceName ?? params.title,
    noteEntries: params.notes ?? [],
    transcriptChunks: (params.transcript ?? []).map((chunk, index) => ({
      id: `t-${index}`,
      startMs: chunk.startMs,
      endMs: chunk.startMs + 5_000,
      text: chunk.text
    })),
    signature: '1'
  }
}

function inventoryFrom(meetings: IndexedMeeting[], emptyCount: number): MeetingInventoryItem[] {
  const noted = meetings.map((entry) => ({
    meetingId: entry.meetingId,
    title: entry.title,
    date: entry.date,
    sourceName: entry.sourceName,
    hasNotes: entry.noteEntries.length > 0,
    hasTranscript: entry.transcriptChunks.length > 0
  }))
  const empty: MeetingInventoryItem[] = Array.from({ length: emptyCount }, (_, index) => ({
    meetingId: `empty-${index}`,
    title: `Recording ${index + 1}`,
    date: Date.UTC(2026, 0, index + 1),
    sourceName: null,
    hasNotes: false,
    hasTranscript: false
  }))
  return [...noted, ...empty].sort((a, b) => b.date - a.date)
}

function realLibraryMeetings(): IndexedMeeting[] {
  return [
    meeting({
      id: HUDDLE_AUG,
      title: 'Huddle: #duet-display - Duet Display - Slack — Aug 20 at 9:31 AM',
      sourceName: 'Huddle: #duet-display - Duet Display - Slack',
      date: Date.UTC(2026, 7, 20, 13, 31),
      notes: [
        note(
          'overview',
          'The impact of trial start timing on early data points, and free tier upgrade banner behavior after a connection ends.'
        ),
        note('t1', 'Free tier users see an upgrade banner when the connection ends.')
      ]
    }),
    meeting({
      id: SQA,
      title: 'Keyboard QA Sync — Aug 18 at 10:30 AM',
      sourceName: 'Keyboard QA Sync',
      date: Date.UTC(2026, 7, 18, 14, 30),
      notes: [
        note(
          'overview',
          'Accent key issues during KMS connection on the Nordic Swedish layout, plus a keyboard layout review.'
        ),
        note('t1', 'Accent key failures may stem from feature flags or missing device properties.'),
        note('pki', 'PKI-related issues with RDP connection errors and local discovery banners.')
      ]
    }),
    meeting({
      id: LATENCY,
      title: 'Latency Test',
      sourceName: 'Keyboard QA Sync',
      date: Date.UTC(2026, 7, 18, 14, 30),
      notes: [
        note(
          'overview',
          'Keyboard input issues during KMS sessions, file transfer restrictions on iPad, RDP connection errors on iOS to Windows, and Duet UI access problems.'
        ),
        note(
          'rdp',
          'RDP connection errors on iOS to Windows devices persist despite the latest update.',
          { title: 'RDP errors' }
        ),
        note('pki', 'Audit feature flags related to PKI and local discovery in Windows service.', {
          category: 'actionItems',
          title: 'Next step'
        })
      ]
    }),
    meeting({
      id: STANDUP,
      title: 'Stand Up — Aug 18 at 9:33 AM',
      sourceName: 'Stand Up',
      date: Date.UTC(2026, 7, 18, 13, 33),
      notes: [note('overview', 'Daily standup status updates.')]
    }),
    meeting({
      id: HUDDLE_MAY,
      title: 'Huddle: #duet-display - Duet Display - Slack — May 20 at 9:30 AM',
      sourceName: 'Huddle: #duet-display - Duet Display - Slack',
      date: Date.UTC(2026, 4, 20, 13, 30),
      notes: [note('overview', 'Earlier huddle about display mirroring.')]
    }),
    meeting({
      id: 'note-test-1',
      title: 'Note Test 1 — May 22 at 4:35 PM',
      sourceName: 'Note Test 1',
      date: Date.UTC(2026, 4, 22, 20, 35),
      notes: [
        note('deploy', 'Deploy updated config today with real data.', {
          title: 'Deploy updated config today with real data',
          deadline: 'today'
        })
      ]
    }),
    meeting({
      id: 'note-test-6',
      title: 'Note Test 6 — May 20 at 9:30 AM',
      sourceName: 'Huddle: #duet-display - Duet Display - Slack',
      date: Date.UTC(2026, 4, 20, 13, 30),
      notes: [
        note(
          'scroll',
          "[them] Okay, so yeah, I can kind of summarize what I think he's talking about.",
          { title: 'Clarify Scrolling Direction for Mirror and Extend Modes' }
        ),
        note(
          'hover',
          'The team discussed hover gestures. They also talked about potential issues related to touch interactions.'
        )
      ]
    }),
    meeting({
      id: 'lag-notes',
      title: 'Screen Share Debug — Aug 10 at 2:00 PM',
      sourceName: 'Screen Share Debug',
      date: Date.UTC(2026, 7, 10, 18, 0),
      notes: [note('lat', 'Users reported latency while screen sharing.')]
    }),
    meeting({
      id: 'pki-transcript',
      title: 'Windows Service Review — Aug 5 at 11:00 AM',
      sourceName: 'Windows Service Review',
      date: Date.UTC(2026, 7, 5, 15, 0),
      transcript: [
        {
          startMs: 12_000,
          text: 'Speaker 1: We still need to ship the notary stamp on the installer.'
        }
      ]
    })
  ]
}

function fakeStore(meetings: IndexedMeeting[], emptyCount = 0) {
  const inventory = inventoryFrom(meetings, emptyCount)
  return {
    ensureLoaded: vi.fn(async () => undefined),
    listInventory: vi.fn(async () => inventory),
    listMeetings: vi.fn(async () => meetings),
    getMeeting: vi.fn(
      async (id: string) => meetings.find((meeting) => meeting.meetingId === id) ?? null
    )
  }
}

describe('ask-ai-answer extractive librarian', () => {
  it('answers the eight real-library questions without calling a model', async () => {
    const ollama = vi.fn()
    const meetings = realLibraryMeetings()
    const store = fakeStore(meetings, 42)
    expect((await store.listInventory()).length).toBe(51)

    const count = await answerQuestion({
      question: 'how many recordings do I have?',
      session: createAskAiSession(),
      store
    })
    expect(count.intent).toBe('count')
    expect(count.content).toBe('You have 51 recordings.')

    const recent = await answerQuestion({
      question: 'what are my most recent meetings?',
      session: createAskAiSession(),
      store
    })
    expect(recent.intent).toBe('list')
    expect(recent.content).toContain('Huddle: #duet-display')
    expect(recent.content).not.toContain('calendar meetings')

    const last = await answerQuestion({
      question: 'what was my most recent recording about?',
      session: createAskAiSession(),
      store
    })
    expect(last.intent).toBe('summary')
    expect(last.content).toContain('trial start timing')
    expect(last.sources?.length).toBeGreaterThan(0)

    const actions = await answerQuestion({
      question: 'what action items do I have?',
      session: createAskAiSession(),
      store
    })
    expect(actions.intent).toBe('actions')
    expect(actions.content).toContain('PKI')

    const sqa = await answerQuestion({
      question: 'what did we talk about in the Keyboard QA Sync?',
      session: createAskAiSession(),
      store
    })
    expect(sqa.intent).toBe('summary')
    expect(sqa.content).toContain('Keyboard QA Sync')
    expect(sqa.content).toContain('Accent key')
    expect(sqa.content).not.toMatch(/did not occur/i)
    expect(sqa.content).not.toContain('Which one should I use')
    expect(sqa.sources?.length).toBeGreaterThan(0)

    const rdp = await answerQuestion({
      question: 'what did we say about RDP connection errors?',
      session: createAskAiSession(),
      store
    })
    expect(rdp.intent).toBe('lookup')
    expect(rdp.content).toMatch(/Latency Test/)
    expect(rdp.content).toMatch(/Yes —/)
    expect(rdp.content).toContain('RDP connection errors')
    expect(rdp.content).not.toContain('Note Test 6')
    expect(rdp.sources?.length).toBeGreaterThan(0)

    const latency = await answerQuestion({
      question: 'what happened in the Latency Test?',
      session: createAskAiSession(),
      store
    })
    expect(latency.intent).toBe('summary')
    expect(latency.content).toContain('Latency Test')
    expect(latency.content).not.toMatch(/did not occur/i)
    expect(latency.content).not.toContain('actually titled')

    const huddle = await answerQuestion({
      question: 'what was the Slack huddle in duet-display about?',
      session: createAskAiSession(),
      store
    })
    expect(huddle.intent).toBe('clarify')
    expect(huddle.content).toContain('Aug 20')
    expect(huddle.content).toContain('May 20')
    expect(huddle.content).not.toContain('Note Test 6')
    expect(huddle.clarificationOptions?.length).toBeGreaterThanOrEqual(2)

    expect(ollama).not.toHaveBeenCalled()
  })

  it('hits a closed synonym paraphrase instead of missing', async () => {
    const result = await answerQuestion({
      question: 'what did we say about screen sharing lag?',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    expect(expandQuestionWithSynonyms('screen sharing lag')).toContain('latency')
    expect(result.intent).toBe('lookup')
    expect(result.content).toContain('latency')
    expect(result.content).toMatch(/mentions/i)
  })

  it('falls back to an extractive transcript quote when notes miss', async () => {
    const result = await answerQuestion({
      question: 'what did we say about the notary stamp?',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    expect(result.content).toMatch(/transcript/i)
    expect(result.content).toContain('notary stamp')
    expect(result.sources?.[0]?.category).toBe('transcript')
    expect(result.sources?.[0]?.startMs).toBe(12_000)
  })

  it('redirects a true zero-match to meetings that have notes', async () => {
    const result = await answerQuestion({
      question: 'what did we decide about the mars colony cafeteria?',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    expect(result.intent).toBe('no_match')
    expect(result.content).toMatch(/didn't find/i)
    expect(result.content).toMatch(/cafeteria|mars/i)
    expect(result.content).not.toContain('Meetings with notes')
  })

  it('compares two titled meetings extractively without a model', async () => {
    const ollama = vi.fn()
    const result = await answerQuestion({
      question: 'compare the Keyboard QA Sync and the Latency Test',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    expect(result.intent).toBe('compare')
    expect(result.content).toContain("Here's what each meeting's notes say")
    expect(result.content).toContain('Keyboard QA Sync')
    expect(result.content).toContain('Latency Test')
    expect(ollama).not.toHaveBeenCalled()
  })

  it('routes explicit calendar words to calendar and bare meetings to recordings', async () => {
    expect(isExplicitCalendarQuestion("what's on my calendar today")).toBe(true)
    expect(isExplicitCalendarQuestion('what are my most recent meetings?')).toBe(false)

    const calendar = {
      fetchRecent: vi.fn(async () => [
        {
          id: 'cal-1',
          externalId: 'cal-1',
          accountId: 'google',
          provider: 'google' as const,
          recurringEventId: null,
          title: 'Design Sync',
          startTime: Date.UTC(2026, 7, 26, 15, 0),
          endTime: Date.UTC(2026, 7, 26, 15, 30),
          attendees: [],
          meetingUrl: null,
          autoRecord: 'off' as const,
          syncedAt: Date.now()
        }
      ]),
      fetchUpcoming: vi.fn(async () => [])
    }

    const calendarAnswer = await answerQuestion({
      question: "what's on my calendar today",
      session: createAskAiSession(),
      store: fakeStore([]),
      calendar
    })
    expect(calendarAnswer.intent).toBe('calendar')
    expect(calendarAnswer.content).toContain('Design Sync')
    expect(calendar.fetchRecent).toHaveBeenCalled()
  })

  it('requires the topic word for PKI and ignores meetings that only say "talked about"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 7, 26, 14, 20))
    const result = await answerQuestion({
      question: 'did I talk about PKI in any meetings',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    vi.useRealTimers()
    expect(result.intent).toBe('lookup')
    expect(result.content).toMatch(/PKI/i)
    expect(result.content).toMatch(/Keyboard QA Sync|Latency Test/)
    expect(result.content).not.toContain('Note Test 6')
    expect(result.content).not.toContain('talking about')
    expect(result.content).not.toContain('Apple Pencil')
    expect(result.excerpts?.some((excerpt) => excerpt.text.includes('PKI'))).toBe(true)

    const ever = await answerQuestion({
      question: 'have I ever talked about PKI?',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    expect(ever.intent).toBe('lookup')
    expect(ever.content).toMatch(/PKI/i)
    expect(ever.content).not.toContain('Meetings with notes')
  })

  it('lists recordings from today instead of searching notes for the word today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 7, 26, 14, 20))
    const meetings = [
      ...realLibraryMeetings(),
      meeting({
        id: 'today-rec',
        title: 'Standup — Aug 26 at 9:00 AM',
        date: Date.UTC(2026, 7, 26, 13, 0),
        notes: [note('overview', 'Standup notes from this morning.')]
      })
    ]
    const noneToday = await answerQuestion({
      question: 'did I have any meetings today?',
      session: createAskAiSession(),
      store: fakeStore(realLibraryMeetings())
    })
    const someToday = await answerQuestion({
      question: 'did I have any meetings today?',
      session: createAskAiSession(),
      store: fakeStore(meetings)
    })
    vi.useRealTimers()

    expect(noneToday.intent).toBe('list')
    expect(noneToday.content).toMatch(/do not have any recordings from today/i)
    expect(noneToday.content).not.toContain('Note Test 1')
    expect(noneToday.content).not.toContain('Deploy updated config')

    expect(someToday.intent).toBe('list')
    expect(someToday.content).toContain('Standup — Aug 26')
    expect(someToday.content).not.toContain('Note Test 1')
    expect(someToday.content).not.toContain('the notes say')
  })
})

it('does not answer a yesterday question from older notes or transcripts', async () => {
  const old = meeting({
    id: 'old-atlas',
    title: 'Atlas launch review',
    date: Date.UTC(2020, 0, 1),
    notes: [note('overview', 'The Atlas budget is $47,250.')],
    transcript: [{ startMs: 0, text: 'The Atlas budget is $47,250.' }]
  })
  const answer = await answerQuestion({
    question: 'What was the Atlas budget yesterday?',
    session: createAskAiSession(),
    store: fakeStore([old])
  })
  expect(answer.intent).toBe('no_match')
  expect(answer.content).not.toContain('47,250')
  expect(answer.excerpts).toBeUndefined()
})
