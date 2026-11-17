import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/autodoc-conversation-test' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_CONVERSATION', '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('passes arbitrary turns and original language instructions through one writer with real chat roles; resets scope', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      expect(url).toMatch(/\/api\/chat$/)
      const body = JSON.parse(String(init?.body))
      expect(body.format).toBeUndefined()
      if (body.format)
        return {
          ok: true,
          json: async () => ({
            message: {
              content: JSON.stringify({
                operation: 'search',
                subject: 'Fable',
                query: 'Fable code',
                language: 'fr',
                clarification: ''
              })
            },
            eval_count: 10
          })
        }
      requests.push(body)
      return {
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ message: { content: 'Le code est marigold [1].' } }) + '\n'
              )
            )
            c.close()
          }
        })
      }
    })
  )
  const meeting = {
    meetingId: 'fable',
    title: 'Fable workshop',
    date: 0,
    signature: 'a',
    dir: '/unused',
    sourceName: 'Fable',
    noteEntries: [
      {
        id: 'x',
        title: 'Overview',
        topic: null,
        content: 'The Fable recovery code is marigold.',
        owner: null,
        deadline: null,
        category: 'information',
        sources: []
      }
    ],
    transcriptChunks: []
  }
  const calendar = {
    fetchAllRecentEvents: vi.fn(async () => []),
    fetchAllUpcomingEvents: vi.fn(async () => [])
  }
  registerChatIpc(
    '/tmp/no-conversation-recordings',
    {
      waitUntilReady: vi.fn(async () => undefined),
      isServerRunning: vi.fn(async () => true),
      getBaseUrl: () => 'http://localhost:11434'
    },
    { getModel: () => 'test' } as never,
    calendar as never,
    () => 'en',
    {
      meetingIndex: {
        ensureLoaded: vi.fn(),
        listMeetings: async () => [meeting],
        listInventory: async () => [meeting]
      } as never
    }
  )
  const handler = (name: string) =>
    vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === name)![1]
  const sender = { id: 31, send: vi.fn() }
  await handler('chat:send-stream')({ sender } as never, 'a', 'Summarize Fable')
  const history = [
    { role: 'user', content: 'Summarize Fable' },
    { role: 'assistant', content: 'The code is marigold.' }
  ]
  await handler('chat:send-stream')(
    { sender } as never,
    'b',
    'Turn that into a reminder. Reply in French.',
    history
  )
  expect(requests).toHaveLength(2)
  const second = requests[1].messages
  expect(second).toContainEqual(history[0])
  expect(second).toContainEqual(history[1])
  expect(
    second.find(
      (message) => message.role === 'user' && message.content.includes('Current user request:')
    )?.content
  ).toContain('Reply in French.')
  expect(second[0]).toEqual(requests[0].messages[0])
  expect(second[1].content).toContain('French')
  expect(second.find((message) => message.content.includes('Meeting evidence'))?.content).toContain(
    'earlier search match'
  )
  expect(calendar.fetchAllRecentEvents).toHaveBeenCalledTimes(1)
  await handler('chat:new')({ sender } as never)
  await handler('chat:send-stream')({ sender } as never, 'c', 'What was it?')
  expect(requests).toHaveLength(3) // one normal streamed writer, no interpreter; native clarification stays authoritative
  expect(sender.send).toHaveBeenCalledWith(
    'chat:done',
    expect.objectContaining({ requestId: 'c', content: 'Which meeting or topic do you mean?' })
  )
})

it('does not drop correct retrieved evidence when the writer cites the wrong source number', async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      return {
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ message: { content: 'Ridge has a budget of $40. [2]' } }) + '\n'
              )
            )
            c.close()
          }
        })
      }
    })
  )
  const meetings = ['ridge', 'vale'].map((id) => ({
    meetingId: id,
    title: id === 'ridge' ? 'Ridge review' : 'Vale review',
    date: 0,
    signature: id,
    dir: '/unused',
    sourceName: id,
    noteEntries: [
      {
        id: 'x',
        title: 'Overview',
        topic: null,
        content: id === 'ridge' ? 'Ridge has a budget of $40.' : 'Vale has a budget of $20.',
        owner: null,
        deadline: null,
        category: 'information',
        sources: []
      }
    ],
    transcriptChunks: []
  }))
  registerChatIpc(
    '/tmp/no-citation-scope-recordings',
    {
      waitUntilReady: vi.fn(async () => undefined),
      isServerRunning: vi.fn(async () => true),
      getBaseUrl: () => 'http://localhost:11434'
    },
    { getModel: () => 'test' } as never,
    { fetchAllRecentEvents: async () => [], fetchAllUpcomingEvents: async () => [] } as never,
    () => 'en',
    {
      meetingIndex: {
        ensureLoaded: vi.fn(),
        listMeetings: async () => meetings,
        listInventory: async () => meetings
      } as never
    }
  )
  const send = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === 'chat:send-stream')![1]
  const sender = { id: 73, send: vi.fn() }
  await send({ sender } as never, 'first', 'Compare Ridge with Vale')
  await send({ sender } as never, 'second', 'Say it more briefly.', [
    { role: 'user', content: 'Compare Ridge with Vale' },
    { role: 'assistant', content: 'Ridge has a budget of $40.' }
  ])
  expect(requests).toHaveLength(2)
  // The deliberately wrong [2] points to Vale. It must not erase Ridge.
  expect(requests[1].messages[1].content).toContain('Ridge has a budget of $40.')
})
