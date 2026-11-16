import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
const frozen = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'src/main/services/__tests__/fixtures/ask-ai-append-c756.json'),
    'utf8'
  )
)
const originalPlatform = process.platform
const originalArch = process.arch

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.doUnmock('os')
  vi.resetModules()
})
async function tier(platform: NodeJS.Platform, arch: string, memory: number) {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof import('os')>('os')),
    totalmem: () => memory * 1024 ** 3
  }))
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', undefined)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', undefined)
  return import('../ask-ai-writer')
}
const final = { message: { content: 'Captured [1].' }, done: true }
const tool = {
  message: {
    content: 'Checking.',
    tool_calls: [
      {
        id: 'calc-1',
        function: { name: 'calculate', arguments: { operation: 'sum', values: ['0.1', '0.2'] } }
      }
    ]
  },
  done: true
}

// Apply only the W1 sentence move to the immutable pre-W1 request bytes.
function languageMove(request: any) {
  const copy = JSON.parse(JSON.stringify(request))
  const sentence =
    'Default reply language: English. An explicit language request in the current question overrides this default; use only the requested language.'
  copy.messages[0].content += ' ' + sentence
  for (const message of copy.messages.slice(1))
    if (message.role === 'user') message.content = message.content.replace(' ' + sentence, '')
  return copy
}
async function sequence(writer: typeof import('../ask-ai-writer'), scenario: any) {
  const { createAppendWriterState } = await import('../ask-ai-append')
  const state = createAppendWriterState(),
    requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(requests.length === 1 ? tool : final) + '\n')
    })
  )
  for (const turn of scenario.turns) {
    if (turn.forceOversize && state.requestMessages)
      state.requestMessages[1].content += ' oversized '.repeat(10000)
    await writer.streamAskAiWriter({
      ...turn.params,
      executeTool: async () => ({ result: '0.3' }),
      onChunk: () => {},
      append: {
        state,
        sources: turn.params.excerpts.map((e: any, i: number) => ({
          n: i + 1,
          meetingId: e.meetingId,
          title: e.title,
          quote: e.text,
          startMs: 0,
          category: e.kind
        }))
      }
    })
  }
  return requests
}
it.each([
  ['darwin', 'arm64', 8, false, 'Mac 8 GB'],
  ['darwin', 'arm64', 24, true, 'Mac 16 GB+'],
  ['darwin', 'x64', 16, false, 'Intel Mac'],
  ['win32', 'x64', 16, false, 'Windows NVIDIA'],
  ['win32', 'x64', 16, false, 'Windows integrated Vulkan'],
  ['win32', 'x64', 16, false, 'Windows CPU'],
  ['linux', 'x64', 24, false, 'Linux']
] as const)(
  'keeps frozen requests on %s/%s/%s GiB (Append-8k=%s, %s), plus only W1',
  async (platform, arch, memory, qualifies, backend) => {
    // Acceleration changes the backend, never the frozen writer request.
    vi.stubEnv('AUTODOC_OLLAMA_VULKAN', backend.includes('Vulkan') ? '1' : '0')
    vi.stubEnv('CUDA_VISIBLE_DEVICES', backend.includes('NVIDIA') ? '0' : '-1')
    const writer = await tier(platform, arch, memory)
    for (const scenario of frozen) {
      // The off arm is today's layout; the on arm is the tested append layout.
      const explicitOff = scenario.appendFlag === '0'
      vi.stubEnv(
        'AUTODOC_ASK_AI_APPEND_FOLLOWUPS',
        explicitOff ? (qualifies ? '0' : undefined) : qualifies ? undefined : '1'
      )
      const actual = await sequence(writer, scenario)
      const expected = scenario.requests.map((request: any) => {
        const copy = languageMove(request)
        if (qualifies && !explicitOff) copy.options.num_ctx = 8192
        return copy
      })
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    }
  }
)
it('honors explicit overrides in both directions and keeps the hardware decision for the session', async () => {
  await tier('darwin', 'arm64', 24)
  const { appendWriterContexts } = await import('../ask-ai-append')
  expect(appendWriterContexts(4096)).toEqual({ numCtx: 8192, packingNumCtx: 4096 })
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  expect(appendWriterContexts(4096).numCtx).toBe(8192)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '0')
  expect(appendWriterContexts(4096).numCtx).toBe(4096)
  await tier('darwin', 'arm64', 8)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', '8192')
  expect((await import('../ask-ai-append')).appendWriterContexts(4096).numCtx).toBe(8192)
})
it('rebuilds with the new system language and uses that rebuild as the following base', async () => {
  const writer = await tier('darwin', 'arm64', 24)
  const { createAppendWriterState } = await import('../ask-ai-append')
  const state = createAppendWriterState(),
    requests: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(final) + '\n')
    })
  )
  for (const [index, language] of ['en', 'ja', 'ja'].entries()) {
    const params = frozen[1].turns[Math.min(index, 1)].params
    await writer.streamAskAiWriter({
      ...params,
      language,
      conversation: { ...params.conversation, replyLanguage: language },
      executeTool: async () => ({}),
      onChunk: () => {},
      append: { state, sources: [] }
    })
  }
  expect(requests[1].messages[0].content).toContain('Default reply language: Japanese.')
  expect(requests[1].messages[0].content).not.toContain('Default reply language: English.')
  expect(requests[1].messages[1].content).toContain('Alder three review')
  expect(requests[2].messages.slice(0, requests[1].messages.length)).toEqual(requests[1].messages)
})
it('retries an 8192 load failure once at the prior context, disables append session-wide and logs once', async () => {
  const writer = await tier('darwin', 'arm64', 24),
    contexts: number[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      contexts.push(JSON.parse(String(init.body)).options.num_ctx)
      if (contexts.length === 1)
        return new Response('failed to load model: out of memory', { status: 500 })
      return new Response(JSON.stringify(final) + '\n')
    })
  )
  const params = frozen[1].turns[0].params
  await writer.streamAskAiWriter({ ...params, onChunk: () => {} })
  await writer.streamAskAiWriter({ ...params, onChunk: () => {} })
  expect(contexts).toEqual([8192, 4096, 4096])
  expect((await import('../ask-ai-append')).appendWriterContexts(4096).numCtx).toBe(4096)
  const { logAutodocEvent } = await import('../autodoc-log')
  expect(
    vi
      .mocked(logAutodocEvent)
      .mock.calls.filter(([entry]) => entry.message.includes('append disabled'))
  ).toHaveLength(1)
})

it.each([
  'llama runner process has terminated',
  'model requires more system memory',
  'failed to load model from /synthetic/model.gguf'
])('retries the recognized load failure before answer text: %s', async (reason) => {
  const writer = await tier('darwin', 'arm64', 24),
    contexts: number[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      contexts.push(JSON.parse(String(init.body)).options.num_ctx)
      if (contexts.length === 1) return new Response(reason, { status: 500 })
      return new Response(JSON.stringify(final) + '\n')
    })
  )
  await writer.streamAskAiWriter({ ...frozen[1].turns[0].params, onChunk: () => {} })
  expect(contexts).toEqual([8192, 4096])
})
it('honors the shared typed model-load failure classification even without matching message text', async () => {
  await tier('darwin', 'arm64', 24)
  const { withAskAiWriterLoadFallback } = await import('../ask-ai-writer-session')
  const { createOllamaModelLoadFailedError } = await import('../ollama-model-load-failure')
  const operation = vi
    .fn()
    .mockRejectedValueOnce(createOllamaModelLoadFailedError('Unavailable model file'))
    .mockResolvedValueOnce('ok')
  await expect(withAskAiWriterLoadFallback(4096, operation)).resolves.toBe('ok')
  expect(operation).toHaveBeenCalledTimes(2)
})
it('never retries a runner failure after answer text has streamed', async () => {
  const writer = await tier('darwin', 'arm64', 24),
    fetcher = vi.fn(async () => {
      let sent = false
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ message: { content: 'Partial answer' } }) + '\n'
                )
              )
            } else controller.error(Error('llama runner process has terminated'))
          }
        })
      )
    }),
    chunk = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(
    writer.streamAskAiWriter({ ...frozen[1].turns[0].params, onChunk: chunk })
  ).rejects.toThrow('llama runner process has terminated')
  expect(chunk).toHaveBeenCalledWith('Partial answer')
  expect(fetcher).toHaveBeenCalledOnce()
  expect((await import('../ask-ai-writer-session')).useAskAiAppendFollowups()).toBe(true)
})
it('restores non-append source numbering before a load-failure retry', async () => {
  const writer = await tier('darwin', 'arm64', 24)
  const { createAppendWriterState } = await import('../ask-ai-append')
  const state = createAppendWriterState(),
    prepared: any[] = [],
    contexts: number[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      contexts.push(JSON.parse(String(init.body)).options.num_ctx)
      if (contexts.length === 2)
        return new Response('llama runner process has terminated', { status: 500 })
      return new Response(JSON.stringify(final) + '\n')
    })
  )
  const sources = (params: any) =>
    params.excerpts.map((e: any, i: number) => ({
      n: i + 1,
      meetingId: e.meetingId,
      title: e.title,
      quote: e.text,
      startMs: 0,
      category: e.kind
    }))
  const first = frozen[1].turns[0].params,
    second = frozen[1].turns[1].params
  await writer.streamAskAiWriter({
    ...first,
    executeTool: async () => ({}),
    onChunk: () => {},
    append: { state, sources: sources(first) }
  })
  const originalSources = sources(second)
  await writer.streamAskAiWriter({
    ...second,
    executeTool: async () => ({}),
    onChunk: () => {},
    append: { state, sources: originalSources, onPrepared: (cards) => prepared.push(cards) }
  })
  expect(contexts).toEqual([8192, 8192, 4096])
  expect(prepared).toHaveLength(2)
  expect(prepared[0].map((card: any) => card.n)).toContain(3)
  expect(prepared[1]).toEqual(originalSources)
  expect(prepared[1].map((card: any) => card.n)).toEqual([1, 2])
})
