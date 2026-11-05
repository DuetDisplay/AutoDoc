import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/append-context-warmup' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
import { ipcMain } from 'electron'
const hardware = vi.hoisted(() => ({ qualifies: false }))
vi.mock('../../services/mac-processing-profile', () => ({
  macUsesAskAiAppendFollowups: () => hardware.qualifies
}))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function warmup(
  append: string | undefined,
  context: string | undefined,
  qualifies = false,
  failLoad = false,
  writerModel?: string
) {
  vi.resetModules()
  hardware.qualifies = qualifies
  const { registerChatIpc } = await import('../chat-ipc')
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '0')
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', append)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', context)
  const requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      if (failLoad && requests.length === 1)
        return new Response('failed to load model: out of memory', { status: 500 })
      return { ok: true }
    })
  )
  registerChatIpc(
    '/tmp/unused-append-context',
    {
      waitUntilReady: async () => {},
      isServerRunning: async () => true,
      getBaseUrl: () => 'http://localhost:11434',
      getAskAiModel: () => writerModel ?? 'test'
    } as never,
    { getModel: () => (writerModel ? 'llama3.2:3b' : 'test') } as never,
    {} as never,
    () => 'en',
    {
      getWriterContextTokens: () => 4096,
      meetingIndex: { ensureLoaded: async () => {}, listMeetings: async () => [] } as never
    }
  )
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'chat:warmup')![1]
  await handler({} as never)
  if (failLoad) await handler({} as never)
  return requests
}
it('leaves the exact warmup bytes unchanged unless both experiment settings are enabled', async () => {
  const old = await warmup(undefined, undefined)
  expect(old).toHaveLength(1)
  expect(JSON.stringify(await warmup('1', undefined))).toBe(JSON.stringify(old))
  expect(JSON.stringify(await warmup('0', '8192'))).toBe(JSON.stringify(old))
  const on = await warmup('1', '8192')
  expect(on[0].options.num_ctx).toBe(8192)
  on[0].options.num_ctx = 4096
  expect(JSON.stringify(on)).toBe(JSON.stringify(old))
})

it('uses the same tested 8192 warmup on qualifying hardware and preserves all other bytes', async () => {
  const old = await warmup(undefined, undefined)
  const next = await warmup(undefined, undefined, true)
  expect(next).toEqual(
    old.map((request) => ({ ...request, options: { ...request.options, num_ctx: 8192 } }))
  )
  expect(await warmup('0', undefined, true)).toEqual(old)
})
it('retries a warmup load failure once and retains the session fallback for later warmups', async () => {
  const requests = await warmup(undefined, undefined, true, true)
  expect(requests.map((request) => request.options.num_ctx)).toEqual([8192, 4096, 4096])
})

it('keeps Ask AI on its selected Qwen writer while the shared notes provider selects a small model', async () => {
  const requests = await warmup(undefined, undefined, true, false, 'qwen3:4b-instruct')
  expect(requests[0].model).toBe('qwen3:4b-instruct')
})
