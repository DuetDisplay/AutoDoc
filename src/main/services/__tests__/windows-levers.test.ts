import { afterEach, expect, it, vi } from 'vitest'
import baseline from './fixtures/windows-levers-defaults.json'
import { leverWriterCases, leverMeetings } from './windows-levers-fixtures'
vi.mock('../mac-processing-profile', () => ({ macUsesAskAiAppendFollowups: () => false }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
vi.mock('../crypto', () => ({
  decryptJSON: vi.fn(async () => {
    throw Error('No cache')
  }),
  encryptJSON: vi.fn(async () => undefined)
}))
import { streamAskAiWriter, resolveAskAiWriterContext } from '../ask-ai-writer'
import { AskAiPassages } from '../ask-ai-passages'
import { OllamaEmbeddingProvider } from '../ollama-embedding'
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
async function writerBody(index: number) {
  const item = leverWriterCases()[index]
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return {
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"message":{"content":"answer"},"done":true}\n'))
            c.close()
          }
        })
      }
    })
  )
  const { tools, ...params } = item
  await streamAskAiWriter({
    ...params,
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b-instruct',
    numCtx: 4096,
    ...(tools ? { executeTool: async () => ({}) } : {}),
    onChunk: () => {}
  })
  return bodies[0]
}
const provider = () => ({ model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() })
it('keeps =0 writer request bytes identical to the pre-lever source', async () => {
  for (const key of [
    'AUTODOC_ASK_AI_MAX_PASSAGES',
    'AUTODOC_ASK_AI_EMBEDDING_MODEL',
    'AUTODOC_ASK_AI_WRITER_MODEL'
  ])
    vi.stubEnv(key, undefined)
  vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '0')
  for (let i = 0; i < leverWriterCases().length; i++)
    expect(await writerBody(i)).toBe(baseline.writerBodies[i])
})
it('keeps retrieval bytes identical when the passage flag is unset, and raises only the cap when enabled', async () => {
  const retrieve = () =>
    new AskAiPassages(provider(), '/unused/cache').retrieveConversation(
      'What are the approved Atlas project budget dollars?',
      leverMeetings(),
      [],
      [],
      undefined,
      undefined,
      () => false
    )
  vi.stubEnv('AUTODOC_ASK_AI_MAX_PASSAGES', undefined)
  const control = await retrieve()
  expect(JSON.stringify(control)).toBe(baseline.retrievalBody)
  expect(control?.excerpts).toHaveLength(8)
  vi.stubEnv('AUTODOC_ASK_AI_MAX_PASSAGES', '12')
  const twelve = await retrieve()
  expect(twelve?.excerpts).toHaveLength(12)
  for (const excerpt of control!.excerpts!) expect(twelve!.excerpts).toContainEqual(excerpt)
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_NUM_CTX', '8192')
  expect(resolveAskAiWriterContext(8192)).toBe(8192)
  expect(resolveAskAiWriterContext(4096)).toBe(8192)
  vi.stubEnv('AUTODOC_ASK_AI_MAX_PASSAGES', undefined)
  expect(resolveAskAiWriterContext(4096)).toBe(4096)
})
it('moves only the unchanged reply-language sentence to the end of system, retaining names, tools and packing', async () => {
  for (const index of [0, 1, 2]) {
    vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '0')
    const control = JSON.parse(await writerBody(index))
    vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '1')
    const changed = JSON.parse(await writerBody(index))
    const marker = index === 2 ? 'Respond in the user' : 'Default reply language:'
    const context = control.messages[1].content as string
    const start = context.lastIndexOf(marker)
    expect(start).toBeGreaterThan(0)
    const sentence = context.slice(start)
    expect(changed.messages[0].content).toBe(control.messages[0].content + ' ' + sentence)
    expect(changed.messages[1].content).toBe(context.slice(0, start - 1))
    expect(changed.messages.slice(2)).toEqual(control.messages.slice(2))
    expect({ ...changed, messages: [] }).toEqual({ ...control, messages: [] })
    if (index === 1) expect(changed.messages[1].content).toContain('without transliteration: Atlas')
  }
})
it.each(['darwin', 'win32', 'linux'] as const)(
  'ships Windows L request bytes by default on %s, with only its tested sentence move',
  async (platform) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      for (const index of [0, 1, 2]) {
        const expected = JSON.parse(baseline.writerBodies[index])
        const context = expected.messages[1].content as string
        const marker = index === 2 ? 'Respond in the user' : 'Default reply language:'
        const start = context.lastIndexOf(marker)
        expect(start).toBeGreaterThan(0)
        expected.messages[0].content += ' ' + context.slice(start)
        expected.messages[1].content = context.slice(0, start - 1)
        vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', undefined)
        expect(await writerBody(index)).toBe(JSON.stringify(expected))
        vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '1')
        expect(await writerBody(index)).toBe(JSON.stringify(expected))
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  }
)
it('retains the default embedding bytes and uses a distinct model cache identity for E4', async () => {
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) }
    })
  )
  vi.stubEnv('AUTODOC_ASK_AI_EMBEDDING_MODEL', undefined)
  const control = new OllamaEmbeddingProvider('http://localhost')
  await control.embed(['synthetic Atlas'])
  expect(bodies[0]).toBe(baseline.embeddingBody)
  vi.stubEnv('AUTODOC_ASK_AI_EMBEDDING_MODEL', 'qwen3-embedding:4b')
  const e4 = new OllamaEmbeddingProvider('http://localhost')
  await e4.embed(['synthetic Atlas'])
  expect(JSON.parse(bodies[1])).toEqual({ ...JSON.parse(bodies[0]), model: 'qwen3-embedding:4b' })
  expect(e4.cacheIdentity).not.toBe(control.cacheIdentity)
})
