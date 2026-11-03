vi.mock('../../services/mac-processing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/autodoc-scope-unit' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'
import { ChatRecordingIndex } from '../../services/chat-retrieval'
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const meetings = ['lumen', 'harbor'].map((id) => ({
  meetingId: id,
  title: id === 'lumen' ? 'Lumen review' : 'Harbor review',
  date: 0,
  signature: id,
  dir: '/unused',
  sourceName: id,
  noteEntries: [
    {
      id: 'fact',
      title: 'Overview',
      topic: null,
      content: id === 'lumen' ? 'Lumen owner is Mara.' : 'The Harbor recovery code is violet kite.',
      owner: null,
      deadline: null,
      category: 'information',
      sources: []
    }
  ],
  transcriptChunks: []
}))
function setup() {
  const calendar = {
    fetchAllRecentEvents: vi.fn(async () => []),
    fetchAllUpcomingEvents: vi.fn(async () => [])
  }
  registerChatIpc(
    '/tmp/no-scope-fixtures',
    {
      waitUntilReady: async () => {},
      isServerRunning: async () => true,
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'qwen3:4b-instruct'
    },
    { getModel: () => 'qwen3:4b-instruct' } as never,
    calendar as never,
    () => 'en',
    {
      meetingIndex: {
        listMeetings: async () => meetings,
        listInventory: async () => meetings,
        ensureLoaded: async () => {},
        query: async () => []
      } as never
    }
  )
  return {
    calendar,
    send: vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'chat:send-stream')![1]
  }
}
function response(frame: unknown) {
  return {
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(frame) + '\n'))
        c.close()
      }
    })
  }
}
it('keeps initial questions and follow-ups inside the attached meeting, even when another meeting is named', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return response({ message: { content: 'That answer is not in this meeting.' }, done: true })
    })
  )
  const { send, calendar } = setup()
  const sender = { id: 99, send: vi.fn() }
  await send({ sender } as never, 'first', 'What is the Harbor recovery code?', [], ['lumen'])
  await send(
    { sender } as never,
    'second',
    'And who owns it?',
    [
      { role: 'user', content: 'What is the Harbor recovery code?' },
      { role: 'assistant', content: 'That answer is not in this meeting.' }
    ],
    ['lumen']
  )
  expect(bodies).toHaveLength(2)
  for (const body of bodies) {
    const context = body.messages[1].content
    expect(context).toContain('Only the attached meeting is in scope')
    expect(context).not.toContain('violet kite')
    expect(context).toContain('count: 1')
  }
  const events = sender.send.mock.calls.filter(([name]) => name === 'chat:sources')
  expect(events.length).toBeGreaterThan(0)
  expect(
    events.flatMap(([, payload]) => payload.sources).every((s) => s.meetingId === 'lumen')
  ).toBe(true)
  expect(calendar.fetchAllRecentEvents).not.toHaveBeenCalled()
})
it('applies the same attached scope to the authoritative count tool', async () => {
  vi.spyOn(ChatRecordingIndex.prototype, 'listInventory').mockResolvedValue(
    meetings.map((m) => ({
      id: m.meetingId,
      title: m.title,
      date: 0,
      participants: [],
      attendees: [],
      aliases: [],
      normalizedAliases: [],
      dir: '/unused',
      calendarTitle: null,
      sourceName: null,
      sourceApp: null,
      slackChannel: null,
      notePreview: null,
      transcriptStatus: 'notes',
      metadataSearchText: ''
    }))
  )
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return requests.length === 1
        ? response({
            message: {
              tool_calls: [
                { function: { name: 'count_recordings', arguments: { filter: { list: true } } } }
              ]
            },
            done: true
          })
        : response({
            message: { content: 'I counted 1 attached recording with no filters.' },
            done: true
          })
    })
  )
  const { send } = setup()
  const sender = { id: 100, send: vi.fn() }
  await send({ sender } as never, 'count', 'How many recordings are attached?', [], ['lumen'])
  expect(sender.send).toHaveBeenCalledWith('chat:count-result', {
    requestId: 'count',
    summary: {
      count: 1,
      filterDescription: 'attached saved recordings (no filters)',
      filter: { list: true },
      scoped: true
    }
  })
  expect(requests).toHaveLength(2)
  const tool = requests[1].messages.find((m) => m.role === 'tool')!
  expect(JSON.parse(tool.content)).toMatchObject({
    count: 1,
    recordings: [{ meetingId: 'lumen' }],
    filterDescription: 'attached saved recordings (no filters)'
  })
})
it('rejects a malformed scope instead of silently searching the whole library', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const { send } = setup()
  const sender = { id: 101, send: vi.fn() }
  await send({ sender } as never, 'bad', 'Find the code', [], [])
  expect(sender.send).toHaveBeenCalledWith(
    'chat:error',
    expect.objectContaining({ requestId: 'bad', error: 'Invalid meeting scope' })
  )
  expect(fetcher).not.toHaveBeenCalled()
})
