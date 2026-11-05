import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AskAiIndexStatus } from '../../../shared/ask-ai-index-status'
const state = vi.hoisted(() => ({
  status: { state: 'idle', percent: 0, significant: false } as AskAiIndexStatus,
  request: vi.fn(),
  stop: vi.fn(),
  cache: false,
  busy: false,
  partial: false,
  processing: false,
  options: null as null | { onIdle: () => void; onChange: (status: AskAiIndexStatus) => void },
  prepare: vi.fn(),
  retrieve: vi.fn(),
  admissions: [] as boolean[],
  inspection: vi.fn(),
  readiness: vi.fn(),
  provider: null as null | { isAvailable(): Promise<boolean> },
  onReady: null as null | (() => void)
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/unused/unit-profile' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('fs', async (original) => ({
  ...(await original<typeof import('fs')>()),
  existsSync: () => state.cache
}))
vi.mock('../../services/mac-processing-profile', async (original) => ({
  ...(await original<typeof import('../../services/mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
vi.mock('../../services/ask-ai-index-prewarm', async (original) => ({
  ...(await original<typeof import('../../services/ask-ai-index-prewarm')>()),
  AskAiIndexPrewarm: class {
    constructor(options: typeof state.options) {
      state.options = options
    }
    get ready() {
      return state.status.state === 'ready'
    }
    get semanticReady() {
      return state.partial || this.ready
    }
    whenInspected = state.inspection
    get unavailable() {
      return state.status.state === 'unavailable'
    }
    snapshot() {
      return { ...state.status }
    }
    request = state.request
    stop = state.stop
  }
}))
vi.mock('../../services/ask-ai-passages', () => ({
  AskAiPassages: class {
    constructor(provider: NonNullable<typeof state.provider>) {
      state.provider = provider
    }
    prepare = state.prepare
    retrieveConversation = state.retrieve
    inspect() {
      return { completed: 0, total: 100 }
    }
  }
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from '../../../shared/constants'
const meeting = {
  meetingId: 'sample',
  title: 'Workshop',
  date: 0,
  dir: '/unused',
  sourceName: null,
  signature: 'v1',
  transcriptChunks: [],
  noteEntries: [
    {
      id: 'owner',
      title: 'Owner',
      content: 'Ari owns Workshop.',
      topic: null,
      owner: null,
      deadline: null,
      category: 'information',
      sources: []
    }
  ]
}
const answer = {
  intent: 'lookup',
  content: '',
  primaryMeetingIds: ['sample'],
  selectedMeetingIds: ['sample'],
  selectedTitles: ['Workshop'],
  retrievalConfidence: { confident: true, score: 1, margin: 1, lexicalAnchor: 1 },
  excerpts: [
    { meetingId: 'sample', title: 'Workshop', date: 0, kind: 'note', text: 'Ari owns Workshop.' }
  ],
  sources: [
    {
      n: 1,
      meetingId: 'sample',
      title: 'Workshop',
      quote: 'Ari owns Workshop.',
      startMs: null,
      category: 'note'
    }
  ]
}
let cleanup: ReturnType<typeof registerChatIpc>
const sender = () =>
  Object.assign(new EventEmitter(), { id: 91, send: vi.fn(), isDestroyed: () => false })
function register() {
  cleanup = registerChatIpc(
    '/unused/recordings',
    {
      getAskAiModel: () => 'unit-model',
      getBaseUrl: () => 'http://localhost:11434',
      waitUntilReady: state.readiness,
      isServerRunning: async () => true,
      on: (_event, listener) => {
        state.onReady = listener
      }
    },
    { getModel: () => 'decoy' } as never,
    {
      fetchAllRecentEvents: async () => [],
      fetchAllUpcomingEvents: async () => []
    } as never,
    () => 'en',
    {
      meetingIndex: {
        ensureLoaded: async () => {},
        listMeetings: async () => [meeting],
        listInventory: async () => [meeting]
      } as never,
      canWarmup: () => !state.busy,
      isProcessing: () => state.processing
    }
  )
}
function handler(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.findLast(([name]) => name === channel)![1]
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '1')
  vi.stubEnv('AUTODOC_ASK_AI_CONVERSATION', '1')
  state.status = { state: 'idle', percent: 0, significant: false }
  state.cache = state.busy = state.processing = false
  state.partial = false
  state.admissions = []
  state.inspection.mockResolvedValue(true)
  state.readiness.mockResolvedValue(undefined)
  state.request.mockImplementation(() => {
    state.status.state = 'preparing'
  })
  state.prepare.mockResolvedValue('ready')
  state.retrieve.mockImplementation(async (...args) => {
    state.admissions.push(args[6]())
    return answer
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message: { content: 'Ari [1].' }, done: true }) + '\n')
    )
  )
  register()
})
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('uses lexical retrieval and the writer in the reply language after inspection times out', async () => {
  state.inspection.mockResolvedValue(false)
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({ message: { content: 'Ari vastaa työpajasta [1].' }, done: true }) + '\n'
    )
  )
  const web = sender()
  await handler('chat:send-stream')(
    { sender: web } as never,
    'stalled',
    'Who owns Workshop? Answer in Finnish.',
    []
  )
  expect(state.admissions).toEqual([false])
  expect(state.readiness).toHaveBeenCalled()
  expect(fetch).toHaveBeenCalled()
  const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(request.model).toBe('unit-model')
  expect(JSON.stringify(request.messages)).toContain('Finnish')
  expect(JSON.stringify(web.send.mock.calls)).toContain('Ari vastaa työpajasta [1].')
})

it('does not change ready-index query admission during recording; processing still blocks embeddings', async () => {
  state.status.state = 'ready'
  state.busy = true
  const web = sender()
  await handler('chat:new')({ sender: web } as never)
  await handler('chat:send-stream')({ sender: web } as never, 'a', 'Who owns Workshop?', [])
  state.processing = true
  await handler('chat:new')({ sender: web } as never)
  await handler('chat:send-stream')({ sender: web } as never, 'b', 'Who owns Workshop?', [])
  expect(state.admissions).toEqual([true, false])
})
it('keeps semantic query admission for a new-meeting-only gap during recording', async () => {
  state.status.state = 'paused'
  state.partial = state.busy = true
  const web = sender()
  await handler('chat:new')({ sender: web } as never)
  await handler('chat:send-stream')({ sender: web } as never, 'partial', 'Who owns Workshop?', [])
  expect(state.admissions).toEqual([true])
  expect(state.retrieve.mock.lastCall?.at(-1)).toBe(true)
})
it('runs the writer warmup once after a timed-out inspection completes and its gates reopen', async () => {
  state.inspection.mockResolvedValue(false)
  const web = sender()
  await expect(handler('chat:warmup')({ sender: web } as never)).resolves.toEqual({
    warmed: false,
    reason: 'indexing'
  })
  state.status.state = 'ready'
  state.busy = true
  state.options!.onIdle()
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  state.busy = false
  state.options!.onIdle()
  state.options!.onIdle()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(request).toMatchObject({ model: 'unit-model', stream: false, options: { num_predict: 1 } })
})
it('uses the flag-off warmup request when embeddings are unavailable', async () => {
  state.status.state = 'unavailable'
  state.prepare.mockResolvedValue('unavailable')
  await expect(handler('chat:warmup')({ sender: sender() } as never)).resolves.toEqual({
    warmed: true
  })
  const on = vi.mocked(fetch).mock.calls[0][1]?.body
  cleanup()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '0')
  register()
  await expect(handler('chat:warmup')({ sender: sender() } as never)).resolves.toEqual({
    warmed: true
  })
  expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(on)
})
it('starts at launch or after notes only for a used cache; first open and model installation are real triggers', async () => {
  cleanup.indexChanged('launch')
  cleanup.indexChanged('notes')
  cleanup.indexChanged('model', DEFAULT_OLLAMA_EMBEDDING_MODEL)
  expect(state.request).not.toHaveBeenCalled()
  await handler('chat:warmup')({ sender: sender() } as never)
  expect(state.request).toHaveBeenCalledTimes(1)
  state.cache = true
  cleanup.indexChanged('notes')
  expect(state.request).toHaveBeenCalledTimes(2)
  state.status.state = 'unavailable'
  cleanup.indexChanged('model', DEFAULT_OLLAMA_EMBEDDING_MODEL)
  expect(state.request).toHaveBeenCalledTimes(3)
})

it('queries initial status, pushes structural status and unsubscribes when Ask AI closes', async () => {
  const web = sender()
  state.status = { state: 'preparing', percent: 12, significant: true }
  expect(await handler('chat:index-status')({ sender: web } as never)).toEqual(state.status)
  const next: AskAiIndexStatus = { state: 'paused', percent: 13, significant: true }
  state.options!.onChange(next)
  expect(web.send).toHaveBeenLastCalledWith('chat:index-status-changed', next)
  expect(Object.keys(next).sort()).toEqual(['percent', 'significant', 'state'])
  await handler('chat:close')({ sender: web } as never)
  web.send.mockClear()
  state.options!.onChange({ ...next, state: 'ready', percent: 100 })
  expect(web.send).not.toHaveBeenCalled()
})

it('keeps status pushes on Ask AI self-navigation and removes them when navigating away', async () => {
  const web = sender()
  state.status = { state: 'preparing', percent: 12, significant: true }
  await handler('chat:index-status')({ sender: web } as never)
  web.emit('did-navigate-in-page', {}, 'file:///app/index.html#/ask-ai', true)
  state.options!.onChange({ ...state.status, percent: 13 })
  expect(web.send).toHaveBeenCalledWith('chat:index-status-changed', {
    ...state.status,
    percent: 13
  })
  web.send.mockClear()
  web.emit('did-navigate-in-page', {}, 'file:///app/index.html#/upcoming', true)
  state.options!.onChange({ ...state.status, percent: 14 })
  expect(web.send).not.toHaveBeenCalled()
})

it('warms once after a later incremental index while Ask AI remains open', async () => {
  state.status = { state: 'ready', percent: 100, significant: false }
  const web = sender()
  await handler('chat:warmup')({ sender: web } as never)
  expect(fetch).toHaveBeenCalledTimes(1)
  state.cache = true
  cleanup.indexChanged('notes')
  expect(state.request).toHaveBeenCalledTimes(1)
  state.status = { state: 'ready', percent: 100, significant: false }
  state.options!.onChange(state.status)
  state.options!.onIdle()
  state.options!.onIdle()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
})

it('waits for Ollama before retrieving for a question that names a meeting', async () => {
  state.status.state = 'ready'
  let ready = (): void => {}
  state.readiness.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)))
  const web = sender()
  await handler('chat:new')({ sender: web } as never)
  const sent = handler('chat:send-stream')({ sender: web } as never, 'a', 'Who owns Workshop?', [])
  await vi.waitFor(() => expect(state.readiness).toHaveBeenCalled())
  expect(state.retrieve).not.toHaveBeenCalled()
  ready()
  await sent
  expect(state.retrieve).toHaveBeenCalled()
})

it('rechecks embedding availability once the Ollama server becomes ready', async () => {
  const tags = new Response(JSON.stringify({ models: [{ name: DEFAULT_OLLAMA_EMBEDDING_MODEL }] }))
  vi.mocked(fetch).mockReset()
  vi.mocked(fetch).mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(tags)
  expect(await state.provider!.isAvailable()).toBe(false)
  expect(await state.provider!.isAvailable()).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
  state.onReady!()
  expect(await state.provider!.isAvailable()).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
})
