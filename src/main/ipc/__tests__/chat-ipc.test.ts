import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingMetadata, MeetingSegments } from '../../../shared/types'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/autodoc-chat-ipc-test') },
  ipcMain: { handle: vi.fn() }
}))

import { ipcMain } from 'electron'
import {
  buildFastRetrievalPlan,
  buildFallbackRetrievalPlan,
  extractQuestionTerms,
  isMeetingInventoryQuestion,
  parseChatRetrievalPlan,
  registerChatIpc,
  scoreMeetingRelevance,
  sortMeetingsByQuestion
} from '../chat-ipc'

describe('chat meeting retrieval helpers', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  async function createTempRecordingsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'autodoc-chat-ipc-'))
    tempDirs.push(dir)
    return dir
  }

  it('drops generic filler terms from broad meeting questions', () => {
    expect(extractQuestionTerms('What happened in my stand up meetings this week?')).toEqual([
      'stand'
    ])
  })

  it('prefers stand-up titles over newer unrelated meetings', () => {
    const ranked = sortMeetingsByQuestion(
      [
        { title: 'Slack - Huddle Preview — Apr 1 at 12:40 PM', date: 200 },
        { title: 'Duet Display Stand Up — Apr 1 at 10:39 AM', date: 100 }
      ],
      'What happened in my stand up meetings this week?'
    )

    expect(ranked[0]?.title).toContain('Stand Up')
  })

  it('falls back to note content when the title is generic', () => {
    expect(
      scoreMeetingRelevance(
        'Entire screen — Apr 1 at 10:39 AM',
        'What happened with the iOS rollout?',
        'Pause iOS rollout due to version 3.1.3 issues.'
      )
    ).toBeGreaterThan(
      scoreMeetingRelevance(
        'Entire screen — Apr 1 at 10:39 AM',
        'What happened with the iOS rollout?',
        'Test meeting notes generation and transcription accuracy.'
      )
    )
  })

  it('recognizes time-window meeting inventory questions as calendar-backed', () => {
    expect(isMeetingInventoryQuestion('what meetings did I have this week')).toBe(true)
    expect(isMeetingInventoryQuestion('list my meetings this week')).toBe(true)
    expect(isMeetingInventoryQuestion('how many meetings did I have this week')).toBe(true)
    expect(isMeetingInventoryQuestion('which standups did I have yesterday?')).toBe(true)
    expect(isMeetingInventoryQuestion('who was assigned the billing checklist?')).toBe(false)
    expect(isMeetingInventoryQuestion('which meetings covered calendar access this week?')).toBe(
      false
    )
  })

  it('uses high-confidence fast plans for obvious source choices', () => {
    expect(buildFastRetrievalPlan('what meetings did I have this week')).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: true,
        needsRecordings: false,
        timeRange: 'this_week',
        evidenceMode: 'inventory'
      }
    })

    expect(
      buildFastRetrievalPlan('who owns the billing migration checklist and when is it due?')
    ).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        evidenceMode: 'mixed'
      }
    })

    expect(
      buildFastRetrievalPlan("can you summarize the content from this week's meetings for me")
    ).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        timeRange: 'this_week',
        evidenceMode: 'mixed'
      }
    })

    expect(
      buildFastRetrievalPlan('what did this weeks meetings have as action items?')
    ).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        timeRange: 'this_week',
        evidenceMode: 'mixed'
      }
    })

    expect(
      buildFastRetrievalPlan(
        'Which meeting discussed Google Calendar authentication scopes, and what was the due date?'
      )
    ).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        evidenceMode: 'mixed'
      }
    })

    expect(
      buildFastRetrievalPlan(
        'Which meeting covered the OAuth permission problem with calendar access?'
      )
    ).toMatchObject({
      confidence: 'high',
      plan: {
        needsCalendar: false,
        needsRecordings: true,
        evidenceMode: 'mixed'
      }
    })

    expect(buildFastRetrievalPlan('what should I focus on?')).toMatchObject({
      confidence: 'low'
    })
  })

  it('builds source-aware fallback retrieval plans without example-specific answers', () => {
    expect(buildFallbackRetrievalPlan('what meetings did I have this week')).toMatchObject({
      needsCalendar: true,
      needsRecordings: false,
      timeRange: 'this_week',
      evidenceMode: 'inventory'
    })

    expect(buildFallbackRetrievalPlan('who owns the billing migration checklist?')).toMatchObject({
      needsCalendar: false,
      needsRecordings: true,
      evidenceMode: 'mixed'
    })
  })

  it('normalizes model retrieval plans and falls back on malformed planner output', () => {
    expect(
      parseChatRetrievalPlan(
        JSON.stringify({
          needsCalendar: true,
          needsRecordings: false,
          timeRange: 'this_week',
          recordingSearchQuery: '',
          evidenceMode: 'inventory',
          reason: 'calendar inventory'
        }),
        'what meetings did I have this week'
      )
    ).toMatchObject({
      needsCalendar: true,
      needsRecordings: false,
      timeRange: 'this_week',
      evidenceMode: 'inventory'
    })

    expect(parseChatRetrievalPlan('not json', 'what meetings did I have this week')).toMatchObject({
      needsCalendar: true,
      needsRecordings: false,
      timeRange: 'this_week'
    })
  })

  it('answers direct inventory questions without waiting on Ollama or calendar', async () => {
    const waitUntilReady = vi.fn()
    const fetchAllRecentEvents = vi.fn()
    const fetchAllUpcomingEvents = vi.fn()

    registerChatIpc(
      '/tmp/autodoc-chat-empty',
      {
        waitUntilReady,
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents,
        fetchAllUpcomingEvents
      } as never
    )

    const sendHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send')?.[1]

    await expect(sendHandler?.({} as never, 'How many recordings do I have?')).resolves.toBe(
      'You have 0 recordings.'
    )
    expect(waitUntilReady).not.toHaveBeenCalled()
    expect(fetchAllRecentEvents).not.toHaveBeenCalled()
    expect(fetchAllUpcomingEvents).not.toHaveBeenCalled()
  })

  it('answers meeting inventory questions from calendar without waiting on Ollama', async () => {
    const waitUntilReady = vi.fn()
    const now = new Date()
    now.setHours(10, 0, 0, 0)
    const event = {
      id: 'google_event_1',
      externalId: 'event_1',
      accountId: 'google',
      provider: 'google',
      recurringEventId: null,
      title: 'Design Sync',
      startTime: now.getTime(),
      endTime: now.getTime() + 30 * 60_000,
      attendees: [],
      meetingUrl: null,
      autoRecord: 'off',
      syncedAt: now.getTime()
    }

    registerChatIpc(
      '/tmp/autodoc-chat-empty',
      {
        waitUntilReady,
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([event]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    const sendHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send')?.[1]

    const answer = await sendHandler?.({} as never, 'what meetings did I have today')

    expect(answer).toContain('Design Sync')
    expect(answer).toContain('I found 1 calendar meeting today')
    expect(answer).not.toContain('recording inventory')
    expect(waitUntilReady).not.toHaveBeenCalled()
  })

  it('streams direct inventory answers through chunk and done events', async () => {
    registerChatIpc(
      '/tmp/autodoc-chat-empty',
      {
        waitUntilReady: vi.fn(),
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn(),
        fetchAllUpcomingEvents: vi.fn()
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { send: vi.fn() }

    await streamHandler?.({ sender } as never, 'req-1', 'How many recordings do I have?')

    expect(sender.send).toHaveBeenCalledWith('chat:chunk', {
      requestId: 'req-1',
      content: 'You have 0 recordings.'
    })
    expect(sender.send).toHaveBeenCalledWith('chat:done', {
      requestId: 'req-1',
      content: 'You have 0 recordings.'
    })
  })

  it('routes conversational acknowledgements without retrieval or Ollama', async () => {
    const waitUntilReady = vi.fn()
    const fetchAllRecentEvents = vi.fn()
    const fetchAllUpcomingEvents = vi.fn()

    registerChatIpc(
      '/tmp/autodoc-chat-empty',
      {
        waitUntilReady,
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents,
        fetchAllUpcomingEvents
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { id: 201, send: vi.fn() }

    await streamHandler?.({ sender } as never, 'req-thanks', 'awesome, thank you!', [
      { role: 'assistant', content: 'I found 4 recordings.' }
    ])

    expect(sender.send).toHaveBeenCalledWith('chat:done', {
      requestId: 'req-thanks',
      content: "You're welcome."
    })
    expect(waitUntilReady).not.toHaveBeenCalled()
    expect(fetchAllRecentEvents).not.toHaveBeenCalled()
    expect(fetchAllUpcomingEvents).not.toHaveBeenCalled()
  })

  it('answers count confirmations from prior calendar scope without invoking the model', async () => {
    const waitUntilReady = vi.fn()
    const now = new Date()
    now.setHours(9, 0, 0, 0)
    const events = [0, 1].map((offset) => ({
      id: `google_event_${offset}`,
      externalId: `event_${offset}`,
      accountId: 'google',
      provider: 'google',
      recurringEventId: null,
      title: offset === 0 ? 'Design Sync' : 'Support Triage',
      startTime: now.getTime() + offset * 60 * 60_000,
      endTime: now.getTime() + offset * 60 * 60_000 + 30 * 60_000,
      attendees: [],
      meetingUrl: null,
      autoRecord: 'off',
      syncedAt: now.getTime()
    }))

    registerChatIpc(
      '/tmp/autodoc-chat-empty',
      {
        waitUntilReady,
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue(events),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { id: 202, send: vi.fn() }

    await streamHandler?.({ sender } as never, 'req-calendar', 'what meetings did I have today')
    await streamHandler?.({ sender } as never, 'req-confirm', 'so, i have 8 meetings right?')

    expect(sender.send).toHaveBeenCalledWith('chat:done', {
      requestId: 'req-confirm',
      content: 'Not quite - you have 2 calendar meetings in that list.'
    })
    expect(waitUntilReady).not.toHaveBeenCalled()
  })

  it('resolves ordinal follow-ups against the previously listed recordings', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'newer-roadmap', {
      startedAt: new Date(2026, 5, 1, 10, 0).getTime(),
      sourceName: 'Roadmap Review',
      notes: 'First listed meeting notes.'
    })
    await createRecording(baseDir, 'older-support', {
      startedAt: new Date(2026, 5, 1, 9, 0).getTime(),
      sourceName: 'Support Triage',
      notes: 'Second listed meeting notes about escalation follow-up.'
    })

    registerChatIpc(
      baseDir,
      {
        waitUntilReady: vi.fn(),
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { id: 203, send: vi.fn() }

    await streamHandler?.({ sender } as never, 'req-list', 'list my recordings')
    await streamHandler?.({ sender } as never, 'req-second', 'show notes for the second one')

    expect(sender.send).toHaveBeenCalledWith('chat:done', {
      requestId: 'req-second',
      content: expect.stringContaining('Second listed meeting notes')
    })
    expect(sender.send).not.toHaveBeenCalledWith('chat:done', {
      requestId: 'req-second',
      content: expect.stringContaining('First listed meeting notes')
    })
  })

  it('covers adjacent Ask AI prompt variants around thanks, counts, ordinals, and requests', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'ad83-001-roadmap', {
      startedAt: new Date(2026, 5, 1, 10, 0).getTime(),
      sourceName: 'AD83 Fixture - Roadmap Review',
      notes: 'First listed fixture notes about roadmap sequencing.'
    })
    await createRecording(baseDir, 'ad83-002-support', {
      startedAt: new Date(2026, 5, 1, 9, 0).getTime(),
      sourceName: 'AD83 Fixture - Support Triage',
      notes: 'Second listed fixture notes. Casey owns the escalation follow-up.',
      noteCategory: 'actionItems'
    })
    await createRecording(baseDir, 'ad83-003-design', {
      startedAt: new Date(2026, 5, 1, 8, 0).getTime(),
      sourceName: 'AD83 Fixture - Design Sync',
      notes: 'Third listed fixture notes about onboarding copy.'
    })
    await createRecording(baseDir, 'ad83-004-calendar', {
      startedAt: new Date(2026, 5, 1, 7, 0).getTime(),
      sourceName: 'AD83 Fixture - Calendar Auth Review',
      notes: 'Fourth listed fixture notes about Google Calendar scopes.'
    })

    const waitUntilReady = vi.fn()
    registerChatIpc(
      baseDir,
      {
        waitUntilReady,
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { id: 204, send: vi.fn() }
    const ask = async (
      requestId: string,
      question: string,
      history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    ): Promise<string> => {
      await streamHandler?.({ sender } as never, requestId, question, history)
      return getDoneContent(sender.send, requestId)
    }

    const listAnswer = await ask('req-list', 'list my recordings')
    expect(listAnswer).toContain('I found 4 recordings total')

    await expect(
      ask('req-2nd', 'show notes for the 2nd one', [
        { role: 'user', content: 'list my recordings' },
        { role: 'assistant', content: listAnswer }
      ])
    ).resolves.toContain('Second listed fixture notes')

    await expect(
      ask('req-right-now', 'show notes for the 2nd recording right now')
    ).resolves.toContain('Second listed fixture notes')

    await expect(ask('req-four-then', 'so four then?')).resolves.toBe(
      'Yes, you have 4 local recordings in that list.'
    )
    await expect(ask('req-five-total', 'so five total?')).resolves.toBe(
      'Not quite - you have 4 local recordings in that list.'
    )

    for (const [requestId, prompt] of [
      ['req-ok-cool', 'ok cool'],
      ['req-sounds-good', 'sounds good'],
      ['req-got-it', 'got it'],
      ['req-thx', 'thx']
    ] as const) {
      await expect(
        ask(requestId, prompt, [
          { role: 'user', content: 'list my recordings' },
          { role: 'assistant', content: listAnswer }
        ])
      ).resolves.toBe("You're welcome.")
    }

    await expect(
      ask('req-thanks-request', 'thanks, can you show action items?')
    ).resolves.toContain('Casey owns the escalation follow-up')
    await expect(ask('req-cool-request', 'cool, summarize the third one')).resolves.toContain(
      'Third listed fixture notes'
    )

    expect(waitUntilReady).not.toHaveBeenCalled()
  })

  it('does not pin a new short content question to the previous exact-title recording', async () => {
    const baseDir = await createTempRecordingsDir()
    await createRecording(baseDir, 'slack-qa', {
      startedAt: new Date(2026, 5, 1, 9, 23).getTime(),
      sourceName: 'sqa-testing (Channel) - Duet Display - Slack',
      notes: 'QA huddle notes about smoke testing the release candidate.'
    })
    await createRecording(baseDir, 'billing-review', {
      startedAt: new Date(2026, 5, 1, 10, 30).getTime(),
      sourceName: 'Billing Migration Review',
      notes: 'Morgan owns the billing migration checklist and the due date is Wednesday morning.',
      noteCategory: 'actionItems'
    })

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      const context = body.messages.at(-1)?.content ?? ''
      const answer = context.includes('Billing Migration Review')
        ? 'billing-context'
        : 'stale-slack-context'
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`${JSON.stringify({ message: { content: answer } })}\n`)
          )
          controller.close()
        }
      })
      return { ok: true, body: stream } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    registerChatIpc(
      baseDir,
      {
        waitUntilReady: vi.fn(),
        isServerRunning: vi.fn(),
        getBaseUrl: () => 'http://localhost:11434'
      },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    const streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    const sender = { id: 101, send: vi.fn() }

    await streamHandler?.(
      { sender } as never,
      'req-exact',
      'Summarize sqa-testing (Channel) - Duet Display - Slack'
    )
    await streamHandler?.({ sender } as never, 'req-billing', 'who owns billing migration')

    expect(sender.send).toHaveBeenCalledWith('chat:done', {
      requestId: 'req-billing',
      content: expect.stringContaining('Morgan')
    })
    expect(sender.send).not.toHaveBeenCalledWith('chat:done', {
      requestId: 'req-billing',
      content: expect.stringContaining('sqa-testing')
    })
  })
})

async function createRecording(
  baseDir: string,
  id: string,
  params: {
    startedAt: number
    sourceName: string
    notes: string
    noteCategory?: keyof MeetingSegments
  }
): Promise<void> {
  const meetingDir = join(baseDir, id)
  await mkdir(meetingDir, { recursive: true })
  await writeFile(join(meetingDir, 'mic.webm'), '')

  const metadata: MeetingMetadata = {
    sourceName: params.sourceName,
    startedAt: params.startedAt,
    stoppedAt: params.startedAt + 30 * 60_000,
    durationSeconds: 30 * 60
  }
  await writeFile(join(meetingDir, 'metadata.json'), JSON.stringify(metadata))
  await writeFile(
    join(meetingDir, 'segments.json'),
    JSON.stringify(createSegments(params.notes, params.noteCategory))
  )
}

function createSegments(content: string, noteCategory: keyof MeetingSegments = 'information') {
  const segments: MeetingSegments = {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
  segments[noteCategory] = [
    {
      id: 'note-1',
      meetingId: 'fixture',
      category: noteCategory === 'actionItems' ? 'action_item' : 'information',
      topic: 'QA',
      title: 'Fixture note',
      content,
      assignee: noteCategory === 'actionItems' ? 'Morgan' : null,
      deadline: noteCategory === 'actionItems' ? 'Wednesday morning' : null,
      sourceStartMs: 0,
      sourceEndMs: 10_000
    }
  ]
  return segments
}

function getDoneContent(send: ReturnType<typeof vi.fn>, requestId: string): string {
  const doneCall = send.mock.calls.find(
    ([channel, payload]) => channel === 'chat:done' && payload?.requestId === requestId
  )
  if (!doneCall) throw new Error(`Missing chat:done for ${requestId}`)
  return doneCall[1].content
}
