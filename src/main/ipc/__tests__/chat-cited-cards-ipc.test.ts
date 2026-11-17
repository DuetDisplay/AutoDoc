vi.mock('../../services/mac-processing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/autodoc-cited-cards-test' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function run(flag: string | undefined, tool = false, writerText?: string) {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_CITED_CARDS', flag)
  const sender = { id: 41, send: vi.fn() }
  const requests: unknown[] = []
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      expect(sender.send.mock.calls.filter(([name]) => name === 'chat:sources')).toHaveLength(
        flag === '1' ? 0 : 1
      )
      requests.push(JSON.parse(String(init?.body)))
      const frame =
        tool && calls++ === 0
          ? {
              message: {
                tool_calls: [
                  {
                    id: 'count-1',
                    function: { name: 'count_recordings', arguments: { filter: { list: false } } }
                  }
                ]
              },
              done: true
            }
          : {
              message: {
                content:
                  writerText ??
                  (tool
                    ? 'There are no saved recordings.'
                    : 'Second [2], first [1], repeat [2], invalid [77].')
              },
              done: true
            }
      return {
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify(frame) + '\n'))
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
    dir: '/unused',
    sourceName: null,
    signature: 'one',
    transcriptChunks: [],
    noteEntries: [
      {
        id: 'a',
        title: 'Overview',
        topic: null,
        content: 'Fable access uses a paper badge.',
        owner: null,
        deadline: null,
        category: 'information',
        sources: []
      },
      {
        id: 'b',
        title: 'Decision',
        topic: null,
        content: 'Fable access uses a side door.',
        owner: null,
        deadline: null,
        category: 'decision',
        sources: []
      }
    ]
  }
  registerChatIpc(
    '/tmp/nonexistent-cited-card-library',
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
        ensureLoaded: async () => {},
        listMeetings: async () => [meeting],
        listInventory: async () => [meeting]
      } as never
    }
  )
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === 'chat:send-stream')![1]
  await handler({ sender } as never, 'request', 'What is used for Fable access?')
  return { requests, events: sender.send.mock.calls }
}
it('delays cited cards until completion, emits the cited order, and leaves writer requests/text unchanged', async () => {
  const off = await run('0')
  const on = await run('1')
  expect(JSON.stringify(on.requests)).toBe(JSON.stringify(off.requests))
  const sources = on.events.filter(([name]) => name === 'chat:sources')
  expect(sources).toHaveLength(1)
  expect(sources[0][1].sources.map((s: { n: number }) => s.n)).toEqual([2, 1])
  expect(on.events.findIndex(([name]) => name === 'chat:sources')).toBeGreaterThan(
    on.events.findIndex(([name]) => name === 'chat:chunk')
  )
  expect(on.events.find(([name]) => name === 'chat:done')![1].content).toBe(
    off.events.find(([name]) => name === 'chat:done')![1].content
  )
})
it('keeps the native count display and shows no source cards on a tool answer without citations', async () => {
  const on = await run('1', true)
  expect(on.events.some(([name]) => name === 'chat:count-result')).toBe(true)
  expect(on.events.filter(([name]) => name === 'chat:sources')).toEqual([])
  expect(on.events.find(([name]) => name === 'chat:done')![1].sources).toEqual([])
})
it('keeps flag-off IPC events and writer requests byte-identical to the default', async () => {
  expect(JSON.stringify(await run('0'))).toBe(JSON.stringify(await run(undefined)))
})
// AD-202 Windows: the writer sent only "[0]" and the answer finished blank.
it('answers with the no-match sentence and no source links when the writer sends only [0] with AUTODOC_ASK_AI_AD202_RULES=1', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_AD202_RULES', '1')
  const { events } = await run(undefined, false, '[0]')
  expect(events.filter(([name]) => name === 'chat:sources')).toHaveLength(1)
  expect(events.find(([name]) => name === 'chat:done')![1]).toMatchObject({
    content: "I didn't find that in your notes or transcripts.",
    sources: []
  })
})
it('keeps the writer wording and hides links for a worded [0] reply with AUTODOC_ASK_AI_AD202_RULES=1', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_AD202_RULES', '1')
  const { events } = await run(undefined, false, 'Nothing about parrots is recorded. [0]')
  expect(events.find(([name]) => name === 'chat:done')![1]).toMatchObject({
    content: 'Nothing about parrots is recorded.',
    sources: []
  })
})
