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
  pending: string[] = []
) {
  disposers.push(
    registerChatIpc(
      base,
      {
        getModel,
        getBaseUrl: () => 'http://localhost:11434',
        waitUntilReady: async () => {},
        isServerRunning: async () => true
      },
      { getModel: () => 'notes-only-override' } as never,
      {} as never,
      () => 'en',
      {
        getPendingNotesIds: () => pending,
        meetingIndex: {
          ensureLoaded: async () => {},
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
