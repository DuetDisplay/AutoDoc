vi.mock('../../services/mac-processing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
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
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'test'
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
  expect(second[0].content).toBe(
    requests[0].messages[0].content.replace(
      'Default reply language: English.',
      'Default reply language: French.'
    )
  )
  expect(second[1].content).not.toContain('Default reply language:')
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
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'test'
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

function readinessHarness(runtime: {
  waitUntilReady: () => Promise<void>
  isServerRunning: () => Promise<boolean>
}) {
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
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
    return {
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ message: { content: 'The code is marigold [1].' } }) + '\n'
            )
          )
          c.close()
        }
      })
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  registerChatIpc(
    '/tmp/no-readiness-recordings',
    { ...runtime, getBaseUrl: () => 'http://localhost:11434', getAskAiModel: () => 'test' },
    { getModel: () => 'test' } as never,
    { fetchAllRecentEvents: async () => [], fetchAllUpcomingEvents: async () => [] } as never,
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
  return { fetchMock, handler, sender: { id: 41, send: vi.fn() } }
}

it('waits for Ollama readiness before a writer-bound request streams', async () => {
  const waitUntilReady = vi.fn(async () => undefined)
  const { fetchMock, handler, sender } = readinessHarness({
    waitUntilReady,
    isServerRunning: async () => true
  })
  await handler('chat:send-stream')({ sender } as never, 'a', 'Summarize Fable')
  expect(waitUntilReady).toHaveBeenCalled()
  const writerCall = fetchMock.mock.calls.findIndex(([url]) => url.endsWith('/api/chat'))
  expect(writerCall).toBeGreaterThanOrEqual(0)
  expect(waitUntilReady.mock.invocationCallOrder[0]).toBeLessThan(
    fetchMock.mock.invocationCallOrder[writerCall]
  )
  expect(sender.send).toHaveBeenCalledWith('chat:done', expect.objectContaining({ requestId: 'a' }))
})

it('cancels promptly while waiting for readiness and never calls the writer', async () => {
  const { fetchMock, handler, sender } = readinessHarness({
    waitUntilReady: () => new Promise<void>(() => {}),
    isServerRunning: async () => false
  })
  const pending = handler('chat:send-stream')({ sender } as never, 'a', 'Summarize Fable')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await handler('chat:cancel')({ sender } as never, 'a')
  await pending
  expect(sender.send).toHaveBeenCalledWith('chat:canceled', { requestId: 'a' })
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/api/chat'))).toBe(false)
})

it('reports the reconnecting message when the server is down after the conversation wait', async () => {
  const { handler, sender } = readinessHarness({
    waitUntilReady: async () => undefined,
    isServerRunning: async () => false
  })
  await handler('chat:send-stream')({ sender } as never, 'a', 'Summarize Fable')
  expect(sender.send).toHaveBeenCalledWith('chat:error', {
    requestId: 'a',
    error: 'Local AI is reconnecting. Please try again shortly.'
  })
})
