import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  request: vi.fn(),
  stop: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/unused/unit-profile' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('fs', async (original) => ({
  ...(await original<typeof import('fs')>()),
  existsSync: () => true
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
vi.mock('../../services/ask-ai-index-prewarm', async (original) => ({
  ...(await original<typeof import('../../services/ask-ai-index-prewarm')>()),
  AskAiIndexPrewarm: class {
    ready = true
    unavailable = false
    semanticReady = true
    whenInspected = async () => true
    snapshot = () => ({ state: 'idle', percent: 0, significant: false })
    request = state.request
    stop = state.stop
  }
}))
vi.mock('../../services/ask-ai-passages', () => ({
  AskAiPassages: class {
    prepare = state.prepare
  }
}))
import { ipcMain } from 'electron'
import { registerChatIpc, type OllamaRuntime } from '../chat-ipc'

let cleanup: ReturnType<typeof registerChatIpc>
let availability: boolean | null
const listeners: Record<string, (value?: boolean) => void> = {}
const resolve = vi.fn(async () => availability === true)
function register() {
  const runtime: OllamaRuntime = {
    getAskAiModel: () => 'unit-model',
    getBaseUrl: () => 'http://localhost:11434',
    waitUntilReady: async () => {},
    isServerRunning: async () => true,
    getAskAiAvailability: () => availability,
    resolveAskAiAvailability: resolve,
    on: (event, listener) => {
      listeners[event] = listener
    }
  }
  cleanup = registerChatIpc(
    '/unused/recordings',
    runtime,
    { getModel: () => 'decoy' } as never,
    { fetchAllRecentEvents: async () => [], fetchAllUpcomingEvents: async () => [] } as never,
    () => 'en',
    {
      meetingIndex: { listMeetings: async () => [], listInventory: async () => [] } as never
    }
  )
}
function handler(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.findLast(([name]) => name === channel)![1]
}
const sender = () =>
  Object.assign(new EventEmitter(), { id: 7, send: vi.fn(), isDestroyed: () => false })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '1')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}'))
  )
  availability = true
})
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('indexes and warms up where Ask AI is offered', async () => {
  register()
  cleanup.indexChanged('launch')
  expect(state.request).toHaveBeenCalledTimes(1)
  await expect(handler('chat:warmup')({ sender: sender() } as never)).resolves.toEqual({
    warmed: true
  })
  expect(fetch).toHaveBeenCalled()
})

it('does not index, warm up or load the writer where Ask AI is hidden', async () => {
  availability = false
  register()
  cleanup.indexChanged('launch')
  cleanup.indexChanged('notes')
  cleanup.indexChanged('model', 'unit-embedding')
  await expect(handler('chat:warmup')({ sender: sender() } as never)).resolves.toEqual({
    warmed: false,
    reason: 'disabled'
  })
  handler('chat:index-status')({ sender: sender() } as never)
  expect(state.request).not.toHaveBeenCalled()
  expect(state.prepare).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('waits for the decision at launch, then indexes once it allows Ask AI', () => {
  availability = null
  register()
  cleanup.indexChanged('launch')
  expect(state.request).not.toHaveBeenCalled()
  availability = true
  listeners['ask-ai-availability'](true)
  expect(state.request).toHaveBeenCalledTimes(1)
})

it('drops the launch index request when the decision is to hide, and stops when latched off', () => {
  availability = null
  register()
  cleanup.indexChanged('launch')
  availability = false
  listeners['ask-ai-availability'](false)
  expect(state.request).not.toHaveBeenCalled()
  expect(state.stop).toHaveBeenCalled()
})

it('answers the renderer with the decision and pushes a later change', async () => {
  availability = true
  register()
  const web = sender()
  await expect(handler('chat:availability')({ sender: web } as never)).resolves.toBe(true)
  availability = false
  listeners['ask-ai-availability'](false)
  expect(web.send).toHaveBeenCalledWith('chat:availability-changed', false)
})
