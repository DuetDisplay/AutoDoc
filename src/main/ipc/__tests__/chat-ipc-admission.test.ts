import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/autodoc-admission-test' },
  ipcMain: { handle: vi.fn() }
}))
import { ipcMain } from 'electron'
import { ChatRecordingIndex } from '../../services/chat-retrieval'
import { registerChatIpc } from '../chat-ipc'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '0')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function register(canWarmup: () => boolean, waitUntilReady = vi.fn(async () => undefined)) {
  registerChatIpc(
    '/tmp/nonexistent-admission-test',
    {
      waitUntilReady,
      isServerRunning: vi.fn(async () => true),
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'test'
    },
    { getModel: () => 'test' } as never,
    {} as never,
    () => 'en',
    { canWarmup }
  )
  return vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'chat:warmup')![1]
}

it('does not prepare a model when processing is already busy', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const ready = vi.fn(async () => undefined)
  const warmup = register(() => false, ready)
  await expect(warmup({} as never)).resolves.toEqual({ warmed: false, reason: 'busy' })
  expect(ready).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('rechecks admission after readiness instead of warming during newly started work', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  let idle = true
  const warmup = register(
    () => idle,
    vi.fn(async () => {
      idle = false
    })
  )
  await expect(warmup({} as never)).resolves.toEqual({ warmed: false, reason: 'busy' })
  expect(fetch).not.toHaveBeenCalled()
})

it('the retained legacy native counts use every inventory record without inference', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_CONVERSATION', '0')
  let language = 'en'
  vi.stubEnv('AUTODOC_ASK_AI_PASSAGES', 'both')
  vi.stubEnv('AUTODOC_ASK_AI_INTENTS', 'semantic')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const inventory = Array.from({ length: 104 }, (_, i) => ({
    meetingId: `r${i}`,
    title: `Routine ${i}`,
    date: Date.UTC(2026, 9, 12),
    hasNotes: false,
    hasTranscript: false,
    sourceName: null
  }))
  const store = {
    ensureLoaded: vi.fn(async () => undefined),
    listInventory: vi.fn(async () => inventory),
    listMeetings: vi.fn(async () => []),
    getMeeting: vi.fn(async () => null)
  }
  registerChatIpc(
    '/tmp/nonexistent-admission-test',
    {
      waitUntilReady: vi.fn(),
      isServerRunning: vi.fn(),
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'test'
    },
    { getModel: () => 'test' } as never,
    {} as never,
    () => language,
    { meetingIndex: store as never }
  )
  const send = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'chat:send')![1]
  await expect(send({} as never, 'Combien de réunions enregistrées ai-je ?')).resolves.toBe(
    'Enregistrements: 104'
  )
  await expect(send({} as never, '録音した会議はいくつありますか？')).resolves.toBe('録音: 104')
  const list = String(await send({} as never, '録音した会議の一覧を見せてください。'))
  expect(list).toContain('録音: 104\n10/104')
  expect(list).not.toContain('2023')
  language = 'ja'
  await expect(send({} as never, '録音した会議はいくつありますか？')).resolves.toBe('録音: 104')
  expect(String(await send({} as never, '録音した会議の一覧を見せてください。'))).toContain(
    '録音: 104\n10/104'
  )
  language = 'fr'
  expect(String(await send({} as never, 'Liste mes réunions enregistrées.'))).toContain(
    'Enregistrements: 104\n10/104'
  )
  // The topic-qualified canned clarification belongs to the retained legacy router.
  // Default conversational handling is model-backed, unlike exact inventory aliases above.
  vi.stubEnv('AUTODOC_ASK_AI_CONVERSATION', '0')
  expect(
    String(await send({} as never, 'How many recordings about the budget do I have?'))
  ).toContain('Do you mean all your saved recordings')
  expect(fetch).not.toHaveBeenCalled()
})

it('the default writer counts all104 inventory records with one native tool round and no planner', async () => {
  const inventory = Array.from({ length: 104 }, (_, i) => ({
    id: `r${i}`,
    title: `Routine ${i}`,
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
    transcriptStatus: 'none' as const,
    metadataSearchText: ''
  }))
  vi.spyOn(ChatRecordingIndex.prototype, 'listInventory').mockResolvedValue(inventory)
  const requests: Array<{
    stream: boolean
    format?: unknown
    messages: Array<{ role: string; content: string }>
  }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const message =
        requests.length === 1
          ? {
              tool_calls: [
                { function: { name: 'count_recordings', arguments: { filter: { list: false } } } }
              ]
            }
          : { content: 'J’ai compté104 enregistrements sauvegardés, sans filtre.' }
      return {
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ message, done: true }) + '\n'))
            c.close()
          }
        })
      }
    })
  )
  registerChatIpc(
    '/tmp/nonexistent-admission-test',
    {
      waitUntilReady: async () => {},
      isServerRunning: async () => true,
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => 'test'
    },
    { getModel: () => 'test' } as never,
    { fetchAllRecentEvents: async () => [], fetchAllUpcomingEvents: async () => [] } as never,
    () => 'en',
    {
      meetingIndex: {
        ensureLoaded: async () => {},
        listInventory: async () => inventory.map((m) => ({ meetingId: m.id, ...m })),
        listMeetings: async () => [],
        getMeeting: async () => null
      } as never
    }
  )
  const send = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'chat:send')![1]
  expect(await send({} as never, 'Combien de réunions enregistrées ai-je en tout ?')).toContain(
    '104'
  )
  expect(requests).toHaveLength(2)
  expect(requests.every((r) => r.stream && !r.format)).toBe(true)
  const tool = requests[1].messages.find((m) => m.role === 'tool')!
  expect(JSON.parse(tool.content)).toMatchObject({
    count: 104,
    filterDescription: 'all saved recordings (no filters)'
  })
})
