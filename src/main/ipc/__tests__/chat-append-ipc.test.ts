import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/autodoc-append-test' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
const retrieval = vi.hoisted(() => ({ calls: [] as unknown[][], turn: 0 }))
vi.mock('../../services/ask-ai-passages', () => ({
  AskAiPassages: class {
    async retrieveConversation(...args: unknown[]) {
      retrieval.calls.push(args)
      const id = `p${++retrieval.turn}`
      return {
        intent: 'lookup',
        content: '',
        primaryMeetingIds: [id],
        retrievalConfidence: { confident: true },
        selectedMeetingIds: [id],
        selectedTitles: [id],
        excerpts: [
          {
            passageId: id,
            meetingId: id,
            title: id,
            date: 0,
            kind: 'note',
            text: `Owner ${id} handles the review.`
          }
        ],
        sources: [
          {
            n: 1,
            meetingId: id,
            title: id,
            quote: `Owner ${id} handles the review.`,
            startMs: 0,
            category: 'note'
          }
        ]
      }
    }
  }
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('keeps display references out of retrieval carry, combines cited cards, and resets on chat:new', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
  vi.stubEnv('AUTODOC_ASK_AI_CITED_CARDS', '1')
  retrieval.calls = []
  retrieval.turn = 0
  const requests: any[] = []
  const sender = { id: 63, send: vi.fn() }
  let eventsBeforeTurn = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      expect(
        sender.send.mock.calls.slice(eventsBeforeTurn).filter(([name]) => name === 'chat:sources')
      ).toHaveLength(0)
      requests.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({ message: { content: 'Earlier [1].' }, done: true }) + '\n'
      )
    })
  )
  registerChatIpc(
    '/tmp/nonexistent-append-library',
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
      getWriterContextTokens: () => 4096,
      meetingIndex: {
        ensureLoaded: async () => {},
        listMeetings: async () => [],
        listInventory: async () => []
      } as never
    }
  )
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([n]) => n === 'chat:send-stream')![1]
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([n]) => n === 'chat:new')![1]
  const history = [
    { role: 'user', content: 'Who handles the review?' },
    { role: 'assistant', content: 'Earlier.' }
  ]
  const turn = async (h: unknown[]) => {
    eventsBeforeTurn = sender.send.mock.calls.length
    await handler({ sender } as never, 'r' + requests.length, 'Who handles the review?', h)
  }
  await turn([])
  await turn(history)
  await turn(history)
  expect(retrieval.calls[1][3]).toEqual(['p1'])
  expect(retrieval.calls[2][3]).toEqual(['p2'])
  const thirdDone = sender.send.mock.calls.filter(([n]) => n === 'chat:done').at(-1)![1]
  expect(thirdDone.sources.map((s: any) => [s.n, s.meetingId])).toEqual([[1, 'p1']])
  expect(requests[2].messages.at(-1).content).toContain('[3] p3')
  // Both New chat and Search all meetings use chat:new; retained renderer history must not restore the cache.
  await reset({ sender } as never)
  await turn(history)
  expect(requests[3].messages[1].content).toContain('[1] p4')
  expect(JSON.stringify(requests[3].messages)).not.toContain('Owner p1')
  expect(retrieval.calls[3][3]).toEqual([])
})
