import { readFileSync } from 'fs'
import { resolve } from 'path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('../mac-processing-profile', () => ({ macUsesAskAiAppendFollowups: () => false }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import { streamAskAiWriter } from '../ask-ai-writer'
import { createAppendWriterState } from '../ask-ai-append'
import { logAutodocEvent } from '../autodoc-log'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/main/services/__tests__/fixtures', name), 'utf8')
  )
const baseline = fixture('ask-ai-append-c756.json')
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
// These frozen baselines cover the explicit rollback layout.
beforeEach(() => vi.stubEnv('AUTODOC_ASK_AI_LANGUAGE_IN_SYSTEM', '0'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
const cards = (excerpts: any[]) =>
  excerpts.map((e, i) => ({
    n: i + 1,
    meetingId: e.meetingId,
    title: e.title,
    quote: e.text,
    startMs: 0,
    category: e.kind
  }))
async function sequence(scenario: any, context: string | undefined) {
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', scenario.appendFlag)
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', context)
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
    await streamAskAiWriter({
      ...turn.params,
      executeTool: async () => ({ result: '0.3' }),
      append: { state, sources: cards(turn.params.excerpts) },
      onChunk: () => {}
    })
  }
  return requests
}
const at4k = (request: any) => ({ ...request, options: { ...request.options, num_ctx: 4096 } })

it.each([undefined, '', '4096', 'invalid'])(
  'preserves all c756 request bytes when context override is %s',
  async (context) => {
    for (const scenario of baseline)
      expect(JSON.stringify(await sequence(scenario, context))).toBe(
        JSON.stringify(scenario.requests)
      )
  }
)
it('ignores 8192 when the append flag is off', async () => {
  expect(JSON.stringify(await sequence(baseline[0], '8192'))).toBe(
    JSON.stringify(baseline[0].requests)
  )
})
it('uses 8192 for every call, including initial native-tool rounds and the forced rebuild, changing only num_ctx on those calls', async () => {
  const scenario = baseline[1],
    requests = await sequence(scenario, '8192')
  expect(requests.every((r) => r.options.num_ctx === 8192)).toBe(true)
  for (const index of [0, 1, requests.length - 1])
    expect(JSON.stringify(at4k(requests[index]))).toBe(JSON.stringify(scenario.requests[index]))
})
it('retains the clipped 4096 evidence/history budget on large initial and fallback requests', async () => {
  const params = fixture('ask-ai-writer-f60.json').find(
    (s: any) => s.name === 'followup-long-en'
  ).params
  const run = async (context: string | undefined) => {
    vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
    vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', context)
    const state = createAppendWriterState(),
      requests: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(final) + '\n')
      })
    )
    for (let i = 0; i < 2; i++) {
      if (i) state.requestMessages![1].content += ' oversized '.repeat(10000)
      await streamAskAiWriter({
        ...params,
        executeTool: async () => ({}),
        onChunk: () => {},
        append: { state, sources: cards(params.excerpts) }
      })
    }
    return requests
  }
  const old = await run(undefined),
    next = await run('8192')
  expect(JSON.stringify(next.map(at4k))).toBe(JSON.stringify(old))
  expect(
    vi.mocked(logAutodocEvent).mock.calls.some(([e]) => (e.context as any)?.appendFallback)
  ).toBe(true)
})
it('uses the larger budget only for append fit, allowing an unchanged cached prefix that rebuilds at 4096', async () => {
  const scenario = baseline[1]
  const run = async (context: string | undefined) => {
    vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
    vi.stubEnv('AUTODOC_ASK_AI_APPEND_NUM_CTX', context)
    const state = createAppendWriterState(),
      requests: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(final) + '\n')
      })
    )
    for (const [i, turn] of scenario.turns.slice(0, 2).entries()) {
      if (i) state.requestMessages![1].content += 'padding '.repeat(1000)
      await streamAskAiWriter({
        ...turn.params,
        executeTool: async () => ({}),
        onChunk: () => {},
        append: { state, sources: cards(turn.params.excerpts) }
      })
    }
    return requests
  }
  const old = await run(undefined),
    next = await run('8192')
  expect(JSON.stringify(old[1])).not.toContain('padding ')
  expect(next[1].messages[1].content).toContain('padding ')
  expect(next[1].messages.at(-2)).toEqual({ role: 'assistant', content: 'Captured [1].' })
  expect(next[1].options.num_ctx).toBe(8192)
})
