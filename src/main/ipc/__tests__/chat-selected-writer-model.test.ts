import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ad122-selected-writer' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))
vi.mock('../../services/mac-processing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'
import { selectMacProcessingProfile } from '../../services/mac-processing-profile'
import { selectWindowsProcessingProfile } from '../../services/windows-processing-profile'
import { DEFAULT_OLLAMA_MODEL, LEGACY_OLLAMA_MODEL } from '../../../shared/constants'
import { buildRecordingTitle } from '../../services/recording-title'
import { ASK_AI_WRITER_TOOLS } from '../../services/ask-ai-writer-tools'
const mac = (memory: number, arm = true) =>
  selectMacProcessingProfile({
    platform: 'darwin',
    arch: arm ? 'arm64' : 'x64',
    isAppleSilicon: arm,
    chip: null,
    logicalProcessors: 8,
    totalMemoryGiB: memory,
    freeMemoryGiB: 4,
    memoryPressure: 'green',
    swapUsedGiB: 0
  }).notesModel
const meeting = {
  meetingId: 'atlas',
  title: 'Atlas launch review',
  date: 0,
  dir: '/unused',
  signature: '1',
  sourceName: 'Atlas',
  noteEntries: [
    {
      id: 'owner',
      title: 'Overview',
      topic: null,
      content: 'Mira owns Atlas migration.',
      owner: null,
      deadline: null,
      category: 'information',
      sources: []
    }
  ],
  transcriptChunks: []
}
const disposers: Array<() => void> = []
const directories: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '0')
  vi.stubEnv('AUTODOC_ASK_AI_CONVERSATION', '1')
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_MODEL', undefined)
})
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose())
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
const handler = (name: string) =>
  vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === name)![1]
function register(
  getModel: () => string,
  base = '/tmp/no-selected-writer',
  pending: string[] = [],
  waitUntilReady: () => Promise<void> = async () => {}
) {
  disposers.push(
    registerChatIpc(
      base,
      {
        getAskAiModel: getModel,
        getBaseUrl: () => 'http://localhost:11434',
        waitUntilReady,
        isServerRunning: async () => true
      },
      { getModel: () => 'notes-only-override' } as never,
      {} as never,
      () => 'en',
      {
        getPendingNotesIds: () => pending,
        meetingIndex: {
          ensureLoaded: async () => {},
          invalidate: () => {},
          listMeetings: async () => [meeting],
          listInventory: async () => [meeting]
        } as never
      }
    )
  )
}
it.each([
  ['8 GB Mac', () => mac(8), 'llama3.2:3b'],
  ['Intel Mac', () => mac(16, false), 'llama3.2:3b'],
  [
    'low-spec Windows',
    () =>
      selectWindowsProcessingProfile(
        { logicalProcessors: 4, totalMemoryGiB: 8, freeMemoryGiB: 4 },
        'cpu'
      ).notesModel,
    'llama3.2:3b'
  ],
  ['legacy fallback while Qwen downloads', () => LEGACY_OLLAMA_MODEL, LEGACY_OLLAMA_MODEL],
  ['default Mac tier', () => mac(24), DEFAULT_OLLAMA_MODEL]
] as const)(
  'uses the manager-selected model for writer and warmup: %s',
  async (_name, select, expected) => {
    let selected = 'not-selected-yet'
    register(() => selected)
    selected = select()
    const requests: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }))
        const request = JSON.parse(String(init?.body))
        requests.push(request)
        return new Response(
          JSON.stringify({ message: { content: 'Mira owns Atlas migration [1].' }, done: true }) +
            '\n'
        )
      })
    )
    await handler('chat:warmup')({} as never)
    const sender = { id: 8, send: vi.fn() }
    await handler('chat:send-stream')({ sender } as never, 'selected', 'Who owns Atlas migration?')
    expect(requests.map((request) => request.model)).toEqual([expected, expected])
    expect(sender.send.mock.calls.some(([channel]) => channel === 'chat:done')).toBe(true)
    selected = DEFAULT_OLLAMA_MODEL
    await handler('chat:warmup')({} as never)
    expect(requests.at(-1).model).toBe(DEFAULT_OLLAMA_MODEL)
  }
)
it.each([
  ['8 GB Mac', () => mac(8), false],
  [
    'low-spec Windows',
    () =>
      selectWindowsProcessingProfile(
        { logicalProcessors: 4, totalMemoryGiB: 8, freeMemoryGiB: 4 },
        'cpu'
      ).notesModel,
    false
  ],
  ['default Mac tier', () => mac(24), true]
] as const)(
  'offers native writer tools only on tiers whose model uses them: %s',
  async (_name, select, tools) => {
    register(select)
    const requests: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }))
        requests.push({ url, ...JSON.parse(String(init?.body)) })
        return new Response(
          JSON.stringify({ message: { content: 'Mira owns Atlas migration [1].' }, done: true }) +
            '\n'
        )
      })
    )
    await handler('chat:warmup')({} as never)
    const sender = { id: 11, send: vi.fn() }
    await handler('chat:send-stream')({ sender } as never, 'tools', 'Who owns Atlas migration?')
    const [warmup, writer] = requests
    // Warmup is a bare /api/generate prefix load on every tier, so it never carries tools.
    expect(warmup.url).toMatch(/\/api\/generate$/)
    expect(warmup).not.toHaveProperty('tools')
    expect(writer.url).toMatch(/\/api\/chat$/)
    expect(requests).toHaveLength(2)
    if (tools) {
      expect(writer.tools).toEqual(ASK_AI_WRITER_TOOLS)
      expect(writer.messages[0].content).toContain('Use calculate')
      expect(writer.messages.at(-1).role).toBe('user')
    } else {
      expect(writer).not.toHaveProperty('tools')
      expect(writer.messages[0].content).not.toContain('Use calculate')
      expect(writer.messages.at(-1)).toEqual({ role: 'assistant', content: 'Answer:' })
    }
  }
)
it('uses recording titles for queued meetings not yet present in the index, never raw IDs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ad122-banner-'))
  directories.push(base)
  const id = 'synthetic-uuid-unindexed'
  await mkdir(join(base, id))
  await writeFile(
    join(base, id, 'metadata.json'),
    JSON.stringify({ customTitle: 'Cedar planning', startedAt: 0 })
  )
  register(() => DEFAULT_OLLAMA_MODEL, base, [id, 'missing-uuid'])
  const rows = await handler('chat:notes-work')({} as never)
  expect(rows[0]).toEqual({ meetingId: id, title: 'Cedar planning' })
  expect(rows[1]).toEqual({
    meetingId: 'missing-uuid',
    title: buildRecordingTitle(null, NaN, null)
  })
})

it('waits for startup selection before sending a conversation writer request, even if the serve is already running', async () => {
  let selected = 'not-selected-yet',
    ready!: () => void
  const gate = new Promise<void>((resolve) => {
    ready = resolve
  })
  const wait = vi.fn(() => gate),
    requests: any[] = []
  register(() => selected, '/tmp/readiness-model', [], wait)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }))
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: 'Mira [1].' }, done: true }) + '\n')
    })
  )
  const sender = { id: 9, send: vi.fn() }
  const answer = handler('chat:send-stream')(
    { sender } as never,
    'startup',
    'Who owns Atlas migration?'
  )
  await vi.waitFor(() => expect(wait).toHaveBeenCalled())
  expect(requests).toHaveLength(0)
  selected = 'llama3.2:3b'
  ready()
  await answer
  expect(requests.map((request) => request.model)).toEqual(['llama3.2:3b'])
})
it('uses the Ask AI manager selection in the rollback agent with a decoy shared provider', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_MODE', 'agent')
  vi.resetModules()
  vi.clearAllMocks()
  const { registerChatIpc: registerAgent } = await import('../chat-ipc')
  const requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ message: { content: 'Agent answer.' } }))
    })
  )
  disposers.push(
    registerAgent(
      '/tmp/agent-model',
      {
        getBaseUrl: () => 'http://localhost:11434',
        getAskAiModel: () => 'llama3.2:3b',
        waitUntilReady: async () => {},
        isServerRunning: async () => true
      },
      { getModel: () => 'decoy-provider-model' } as never,
      {} as never
    )
  )
  const sender = { id: 10, send: vi.fn() }
  await handler('chat:send-stream')({ sender } as never, 'agent', 'Who owns Atlas migration?')
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every((request) => request.model === 'llama3.2:3b')).toBe(true)
  expect(sender.send.mock.calls.some(([channel]) => channel === 'chat:done')).toBe(true)
})
