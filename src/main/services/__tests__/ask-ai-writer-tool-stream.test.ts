import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../mac-processing-profile', () => ({ macUsesAskAiAppendFollowups: () => false }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import { streamAskAiWriter } from '../ask-ai-writer'
import { ASK_AI_WRITER_TOOLS } from '../ask-ai-writer-tools'
import { logAutodocEvent } from '../autodoc-log'
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
  describe('tool calls written as text', () => {
    const malformed =
      '{"name":"count_recordings","parameters":{"filter":"{\\"from\\":\\"2026-10-01\\",\\"through\\":\\"2026-10-31\\",\\"title\\":\\"Harbor\\",\\"list\\":true}\\"}}'
    const requestBodies = (fetcher: ReturnType<typeof vi.fn>): Record<string, any>[] =>
      fetcher.mock.calls.map((args) => JSON.parse(String((args as [string, RequestInit])[1].body)))

    it('never shows malformed tool JSON and answers from one tool-less request', async () => {
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? stream([{ message: { content: malformed } }, { done: true }])
          : stream([{ message: { content: 'Mira owns it [1].' } }, { done: true }])
      )
      vi.stubGlobal('fetch', fetcher)
      const executeTool = vi.fn()
      const chunks: string[] = []
      const answer = await streamAskAiWriter({
        ...params,
        executeTool,
        onChunk: (c) => chunks.push(c)
      })
      expect(answer).toBe('Mira owns it [1].')
      expect(chunks.join('')).toBe('Mira owns it [1].')
      expect(chunks.join('')).not.toContain('count_recordings')
      expect(executeTool).not.toHaveBeenCalled()
      const bodies = requestBodies(fetcher)
      expect(bodies).toHaveLength(2)
      expect(bodies[0].tools).toEqual(ASK_AI_WRITER_TOOLS)
      expect(bodies[1]).not.toHaveProperty('tools')
      expect(bodies[1].messages[0].content).not.toContain('Use calculate')
      expect(bodies[1].messages.at(-1)).toEqual({ role: 'assistant', content: 'Answer:' })
      expect(bodies[1].messages.slice(1, -1)).toEqual(bodies[0].messages.slice(1))
      expect(logAutodocEvent).toHaveBeenCalledWith(
        expect.objectContaining({ context: { toolCallRecovered: false, tool: 'count_recordings' } })
      )
    })
    it('treats a truncated call to a declared tool as unusable', async () => {
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? stream([{ message: { content: '{"name":"calculate","param' } }, { done: true }])
          : stream([{ message: { content: 'Fine.' } }, { done: true }])
      )
      vi.stubGlobal('fetch', fetcher)
      const chunks: string[] = []
      expect(
        await streamAskAiWriter({ ...params, executeTool: vi.fn(), onChunk: (c) => chunks.push(c) })
      ).toBe('Fine.')
      expect(chunks).toEqual(['Fine.'])
    })
    it('retries without tools when the runtime rejects a native call, keeping streamed text', async () => {
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? stream([
              { message: { content: 'Checking. ' } },
              {
                error:
                  'llama-server returned invalid tool call arguments: unexpected end of JSON input'
              }
            ])
          : stream([{ message: { content: 'Two meetings.' } }, { done: true }])
      )
      vi.stubGlobal('fetch', fetcher)
      const chunks: string[] = []
      expect(
        await streamAskAiWriter({ ...params, executeTool: vi.fn(), onChunk: (c) => chunks.push(c) })
      ).toBe('Checking. Two meetings.')
      expect(chunks.join('')).toBe('Checking. Two meetings.')
      expect(requestBodies(fetcher)[1]).not.toHaveProperty('tools')
    })
    it('executes valid textual calls like native calls', async () => {
      const text = JSON.stringify({
        name: 'calculate',
        parameters: { operation: 'sum', values: ['0.1', '0.2'] }
      })
      const bodies: Record<string, any>[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(String(init.body)))
          return bodies.length === 1
            ? stream([{ message: { content: text } }, { done: true }])
            : stream([{ message: { content: 'The total is 0.3.' } }, { done: true }])
        })
      )
      const executeTool = vi.fn(async () => ({ result: '0.3' }))
      const chunks: string[] = []
      expect(
        await streamAskAiWriter({ ...params, executeTool, onChunk: (c) => chunks.push(c) })
      ).toBe('The total is 0.3.')
      expect(executeTool).toHaveBeenCalledTimes(1)
      expect(executeTool).toHaveBeenCalledWith(
        {
          function: { name: 'calculate', arguments: { operation: 'sum', values: ['0.1', '0.2'] } }
        },
        expect.stringContaining('Amounts 0.1')
      )
      expect(bodies).toHaveLength(2)
      expect(bodies[1].tools).toEqual(ASK_AI_WRITER_TOOLS)
      expect(bodies[1].messages.at(-2)).toMatchObject({ role: 'assistant', content: '' })
      expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'calculate' })
      expect(chunks.join('')).toBe('The total is 0.3.')
    })
    it('treats a schema-invalid textual call as unusable instead of executing it', async () => {
      const text = JSON.stringify({
        name: 'count_recordings',
        parameters: { filter: { list: 'false' } }
      })
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? stream([{ message: { content: text } }, { done: true }])
          : stream([{ message: { content: 'Mira.' } }, { done: true }])
      )
      vi.stubGlobal('fetch', fetcher)
      const executeTool = vi.fn()
      expect(await streamAskAiWriter({ ...params, executeTool })).toBe('Mira.')
      expect(executeTool).not.toHaveBeenCalled()
      expect(requestBodies(fetcher)[1]).not.toHaveProperty('tools')
    })
    it('passes JSON that does not name a declared tool through unchanged', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => stream([{ message: { content: '{"budget":18600}' } }, { done: true }]))
      )
      const chunks: string[] = []
      const executeTool = vi.fn()
      expect(
        await streamAskAiWriter({ ...params, executeTool, onChunk: (c) => chunks.push(c) })
      ).toBe('{"budget":18600}')
      expect(chunks.join('')).toBe('{"budget":18600}')
      expect(executeTool).not.toHaveBeenCalled()
    })
    it('streams normal prose chunk by chunk before the stream ends', async () => {
      let finish!: () => void
      const gate = new Promise<void>((resolve) => (finish = resolve))
      const encoder = new TextEncoder()
      const frame = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value) + '\n')
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          body: new ReadableStream({
            async start(controller) {
              controller.enqueue(frame({ message: { content: 'Mira ' } }))
              controller.enqueue(frame({ message: { content: 'owns it.' } }))
              await gate
              controller.enqueue(frame({ done: true }))
              controller.close()
            }
          })
        }))
      )
      const chunks: string[] = []
      const pending = streamAskAiWriter({
        ...params,
        executeTool: vi.fn(),
        onChunk: (c) => chunks.push(c)
      })
      await vi.waitFor(() => expect(chunks).toEqual(['Mira ', 'owns it.']))
      finish()
      expect(await pending).toBe('Mira owns it.')
    })
    // Last on purpose: a load failure latches the module-level append fallback for the session.
    it('does not count discarded tool text as streamed, so a model-load failure can still retry', async () => {
      vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', '8192')
      vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++
          if (calls === 1) return stream([{ message: { content: malformed } }, { done: true }])
          if (calls === 2) throw new Error('llama runner process has terminated')
          return stream([{ message: { content: 'Recovered.' } }, { done: true }])
        })
      )
      const chunks: string[] = []
      expect(
        await streamAskAiWriter({
          ...params,
          numCtx: 4096,
          executeTool: vi.fn(),
          onChunk: (c) => chunks.push(c)
        })
      ).toBe('Recovered.')
      expect(calls).toBe(3)
      expect(chunks).toEqual(['Recovered.'])
    })
  })
})
