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
import { registerChatIpc } from '../chat-ipc'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function warmup(append: string | undefined, context: string | undefined) {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', append)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', context)
  const requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return { ok: true }
    })
  )
  registerChatIpc(
    '/tmp/unused-append-context',
    {
      waitUntilReady: async () => {},
      isServerRunning: async () => true,
      getBaseUrl: () => 'http://localhost:11434'
    } as never,
    { getModel: () => 'test' } as never,
    {} as never,
    () => 'en',
    {
      getWriterContextTokens: () => 4096,
      meetingIndex: { ensureLoaded: async () => {}, listMeetings: async () => [] } as never
    }
  )
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'chat:warmup')![1]
  await handler({} as never)
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
