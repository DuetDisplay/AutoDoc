import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../mac-processing-profile', () => ({ macUsesAskAiAppendFollowups: () => false }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import { streamAskAiWriter } from '../ask-ai-writer'
import { ASK_AI_WRITER_TOOLS } from '../ask-ai-writer-tools'
function stream(frames: unknown[]) {
  return {
    ok: true,
    body: new ReadableStream({
      start(c) {
        const text = frames.map((f) => JSON.stringify(f)).join('\n')
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      }
    })
  }
}
const call = {
  id: 'calculation-1',
  function: { name: 'calculate', arguments: { operation: 'sum', values: ['0.1', '0.2'] } }
}
const params = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:4b-instruct',
  question: 'Add the two amounts.',
  excerpts: [
    {
      meetingId: 'a',
      title: 'Workshop',
      date: 0,
      kind: 'note' as const,
      text: 'Amounts 0.1 and0.2.'
    }
  ],
  conversation: { history: [], inventoryCount: 2 },
  numCtx: 4096,
  onChunk: vi.fn()
}
// These frozen baselines cover the explicit rollback layout.
beforeEach(() => vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '0'))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
describe('native streamed single-writer tools', () => {
  it('keeps system and tools byte-identical when evidence names and reply languages change', async () => {
    const bodies: Record<string, any>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return stream([{ message: { content: 'Ready.' } }, { done: true }])
      })
    )
    for (const [name, language] of [
      ['Alder', 'ja'],
      ['Juniper', 'ko']
    ] as const) {
      await streamAskAiWriter({
        ...params,
        question: `Who owns ${name}?`,
        language,
        excerpts: [{ ...params.excerpts[0], title: `${name} review` }],
        conversation: { ...params.conversation, replyLanguage: language },
        executeTool: vi.fn()
      })
    }
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1].messages[0])).toBe(JSON.stringify(bodies[0].messages[0]))
    expect(JSON.stringify(bodies[1].tools)).toBe(JSON.stringify(bodies[0].tools))
    expect(bodies[0].tools).toEqual(ASK_AI_WRITER_TOOLS)
    for (const [index, name, language] of [
      [0, 'Alder', 'Japanese'],
      [1, 'Juniper', 'Korean']
    ] as const) {
      expect(bodies[index].messages[0].content).not.toContain('Keep source names exactly')
      expect(bodies[index].messages[0].content).not.toContain('Default reply language:')
      expect(bodies[index].messages[1]).toMatchObject({ role: 'user' })
      expect(bodies[index].messages[1].content).toContain(
        `Keep source names exactly as spelled, without transliteration: ${name}.`
      )
      expect(bodies[index].messages[1].content).toContain(
        `Default reply language: ${language}. An explicit language request in the current question overrides this default; use only the requested language.`
      )
    }
  })
  it('keeps normal answers to one streamed call with a stable tool prefix and unchanged options', async () => {
    const fetcher = vi.fn(async () => stream([{ message: { content: 'Ready.' } }, { done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const executeTool = vi.fn()
    expect(await streamAskAiWriter({ ...params, executeTool })).toBe('Ready.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(executeTool).not.toHaveBeenCalled()
    const body = JSON.parse(
      String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    )
    expect(body).toMatchObject({
      stream: true,
      think: false,
      tools: ASK_AI_WRITER_TOOLS,
      options: { num_ctx: 4096, num_predict: 220, temperature: 0, repeat_penalty: 1.05 }
    })
    expect(body.messages[0].content).toContain('Use calculate')
    expect(body.messages.at(-1).role).toBe('user')
    expect(body.messages.some((m: { content: string }) => m.content === 'Answer:')).toBe(false)
  })
  it('executes native tool_calls and makes exactly one more streamed writer request with the result', async () => {
    const bodies: Record<string, any>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return bodies.length === 1
          ? stream([{ message: { tool_calls: [call] }, done: true }])
          : stream([{ message: { content: 'The total is0.3.' } }, { done: true }])
      })
    )
    const executeTool = vi.fn(async () => ({ result: '0.3' }))
    const chunks: string[] = []
    expect(
      await streamAskAiWriter({ ...params, executeTool, onChunk: (c) => chunks.push(c) })
    ).toBe('The total is0.3.')
    expect(executeTool).toHaveBeenCalledWith(call, expect.stringContaining('Amounts 0.1'))
    expect(bodies).toHaveLength(2)
    expect(bodies[1].tools).toEqual(bodies[0].tools)
    expect(bodies[1].messages[0]).toEqual(bodies[0].messages[0])
    expect(bodies[1].messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_name: 'calculate',
      tool_call_id: call.id,
      content: '{"result":"0.3"}'
    })
    expect(chunks.join('')).toBe('The total is0.3.')
  })
  it('passes a validation error back without a third request when the model tries to call again', async () => {
    const fetcher = vi.fn(async () => stream([{ message: { tool_calls: [call] }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const executeTool = vi.fn(async () => ({ error: 'Operand absent from evidence' }))
    await expect(streamAskAiWriter({ ...params, executeTool })).rejects.toThrow(/two-call/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(executeTool).toHaveBeenCalledTimes(1)
  })
  it('keeps native first-turn clarification authoritative without adding an interpreter call', async () => {
    const fetcher = vi.fn(async () =>
      stream([{ message: { content: 'An unsupported guess.' } }, { done: true }])
    )
    vi.stubGlobal('fetch', fetcher)
    const chunks = vi.fn()
    const result = await streamAskAiWriter({
      ...params,
      conversation: {
        history: [],
        inventoryCount: 2,
        subjectClarification: 'Which meeting or topic do you mean?'
      },
      executeTool: vi.fn(),
      onChunk: chunks
    })
    expect(result).toBe('Which meeting or topic do you mean?')
    expect(chunks).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('stops before a second request if canceled while a native tool runs', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async () => stream([{ message: { tool_calls: [call] }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      streamAskAiWriter({
        ...params,
        signal: controller.signal,
        executeTool: async () => {
          controller.abort()
          return { result: '0.3' }
        }
      })
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
