import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../mac-processing-profile', () => ({ macUsesAskAiAppendFollowups: () => false }))
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import { logAutodocEvent } from '../autodoc-log'
import {
  buildWriterPrompt,
  shouldRewriteAskAiAnswer,
  streamAskAiWriter,
  resolveAskAiWriterContext
} from '../ask-ai-writer'
import type { AskAiAnswer } from '../ask-ai-answer'

function answer(partial: Partial<AskAiAnswer>): AskAiAnswer {
  return {
    intent: 'lookup',
    content: 'extractive dump',
    selectedMeetingIds: ['m1'],
    selectedTitles: ['Latency Test'],
    ...partial
  }
}

describe('ask-ai-writer', () => {
  it('uses the live selected context and never raises a memory-constrained profile', () => {
    vi.stubEnv('AUTODOC_ASK_AI_WRITER_NUM_CTX', '')
    expect(resolveAskAiWriterContext(4096)).toBe(4096)
    expect(resolveAskAiWriterContext(8192)).toBe(8192)
    vi.stubEnv('AUTODOC_ASK_AI_WRITER_NUM_CTX', '8192')
    expect(resolveAskAiWriterContext(4096)).toBe(4096)
    vi.stubEnv('AUTODOC_ASK_AI_WRITER_NUM_CTX', '2048')
    expect(resolveAskAiWriterContext(4096)).toBe(2048)
    vi.stubEnv('AUTODOC_ASK_AI_WRITER_NUM_CTX', 'not-a-number')
    expect(resolveAskAiWriterContext(4096)).toBe(4096)
    expect(resolveAskAiWriterContext(NaN)).toBe(2048)
  })
  it('rewrites only content answers that already have excerpts', () => {
    expect(shouldRewriteAskAiAnswer(answer({ intent: 'list', excerpts: undefined }))).toBe(false)
    expect(shouldRewriteAskAiAnswer(answer({ intent: 'count' }))).toBe(false)
    expect(shouldRewriteAskAiAnswer(answer({ intent: 'no_match' }))).toBe(false)
    expect(shouldRewriteAskAiAnswer(answer({ intent: 'clarify', excerpts: [] }))).toBe(false)
    expect(
      shouldRewriteAskAiAnswer(
        answer({
          excerpts: [
            {
              meetingId: 'm1',
              title: 'Latency Test',
              date: Date.UTC(2026, 7, 18, 14, 30),
              kind: 'note',
              text: 'Audit feature flags related to PKI.'
            }
          ]
        })
      )
    ).toBe(true)
  })

  it('grounds the writer prompt in excerpts, not the raw library', () => {
    const prompt = buildWriterPrompt('did I talk about PKI this week', [
      {
        meetingId: 'sqa',
        title: 'Keyboard QA Sync',
        date: Date.UTC(2026, 7, 18, 14, 30),
        kind: 'note',
        text: 'Audit feature flags related to PKI and local discovery in Windows service.'
      }
    ])
    expect(prompt).toContain('did I talk about PKI this week')
    expect(prompt).toContain('Keyboard QA Sync')
    expect(prompt).toContain('Audit feature flags related to PKI')
    expect(prompt).toContain('Evidence:')
    expect(prompt).toContain('Do not return a source quotation')
    expect(prompt).not.toContain('Note Test 6')
  })
  it('keeps every enumerated detail without adding an unrelated transcript secret', () => {
    const excerpts = [
      {
        meetingId: 'atlas',
        title: 'Atlas',
        date: 0,
        kind: 'transcript' as const,
        text: 'Mira owns Atlas. The budget is $47,250. The launch is October 23, 2026. A November launch was rejected. The emergency rollback passphrase is cedar falcon.'
      }
    ]
    const detail = buildWriterPrompt(
      'Give a detailed summary of Atlas: owner, approved budget, launch date, and rejected alternative.',
      excerpts
    )
    for (const fact of ['Mira', '$47,250', 'October 23', 'November']) expect(detail).toContain(fact)
    expect(detail).not.toContain('cedar falcon')
    expect(
      buildWriterPrompt(
        'Summarize all recorded Atlas facts including transcript-only details.',
        excerpts
      )
    ).toContain('cedar falcon')
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it('streams chat API content and uses an English assistant prefix without displaying it', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_API', 'chat')
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ message: { content: 'Mira owns ' } }) +
              '\n' +
              JSON.stringify({ message: { content: 'Atlas.' } }) +
              '\n'
          )
        )
        controller.close()
      }
    })
  }))
  vi.stubGlobal('fetch', fetcher)
  const chunks: string[] = []
  const result = await streamAskAiWriter({
    baseUrl: 'http://localhost:11439',
    model: 'qwen3:4b-instruct',
    question: 'Hvem ejer Atlas?',
    excerpts: [],
    language: 'en',
    onChunk: (chunk) => chunks.push(chunk)
  })
  expect(result).toBe('Mira owns Atlas.')
  expect(chunks.join('')).toBe(result)
  expect(fetcher.mock.calls[0][0]).toContain('/api/chat')
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  expect(body.messages[0].content).toContain('entire answer in English')
  expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: 'The answer in English is:' })
})

it('preserves decimal/date evidence and keeps focused evidence ahead of changing questions', () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_PROMPT', 'stable')
  const evidence = [
    {
      meetingId: 'pine',
      title: 'Pine',
      date: 0,
      kind: 'note' as const,
      text: 'The budget is $47.25 million. The launch is Jan. 4, 2027. A February launch was rejected.'
    }
  ]
  const a = buildWriterPrompt('What is the budget?', evidence)
  const b = buildWriterPrompt('When is launch?', evidence)
  expect(a.split('Question:')[0]).toBe(b.split('Question:')[0])
  expect(a).toContain('$47.25 million')
  expect(a).toContain('Jan. 4, 2027')
  expect(a).toContain('February launch was rejected')
})

it('logs only numerical generation metadata from the completed stream', async () => {
  vi.mocked(logAutodocEvent).mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ response: 'Leah.' }) +
                '\n' +
                JSON.stringify({
                  done: true,
                  total_duration: 500000000,
                  load_duration: 10000000,
                  prompt_eval_count: 100,
                  prompt_eval_duration: 200000000,
                  eval_count: 5,
                  eval_duration: 290000000,
                  done_reason: 'stop'
                }) +
                '\n'
            )
          )
          controller.close()
        }
      })
    }))
  )
  const result = await streamAskAiWriter({
    baseUrl: 'http://localhost:11459',
    model: 'qwen3:4b-instruct',
    question: 'Who owns Pine?',
    excerpts: [],
    onChunk: () => {}
  })
  expect(result).toBe('Leah.')
  expect(logAutodocEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Ask AI generation timing',
      context: expect.objectContaining({ promptTokens: 100, decodeMs: 290, outputTokens: 5 })
    })
  )
  expect(JSON.stringify(vi.mocked(logAutodocEvent).mock.calls)).not.toContain('Who owns Pine')
  expect(JSON.stringify(vi.mocked(logAutodocEvent).mock.calls)).not.toContain('Leah')
})

it('focuses requested facts without breaking fractional amounts, abbreviated dates or rejection', () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_PROMPT', 'focused-stable')
  const excerpts = [
    {
      meetingId: 'pine',
      title: 'Pine',
      date: 0,
      kind: 'note' as const,
      text: 'Leah owns Pine security. The budget is $47.25 million. The launch is Jan. 4, 2027. The team rejected a February launch.'
    }
  ]
  const budget = buildWriterPrompt('What is the Pine budget?', excerpts)
  expect(budget).toContain('$47.25 million')
  expect(budget).not.toContain('Leah owns')
  const date = buildWriterPrompt('When is the launch?', excerpts)
  expect(date).toContain('Jan. 4, 2027')
  expect(date).toContain('rejected a February launch')
})

it('streams real OpenAI-style SSE and refuses non-local experimental writer URLs', async () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_API', 'openai')
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_BASE_URL', 'http://127.0.0.1:11462')
  const fetcher = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: ' +
              JSON.stringify({ choices: [{ delta: { content: 'Mira.' } }] }) +
              '\n\ndata: [DONE]\n\n'
          )
        )
        c.close()
      }
    })
  }))
  vi.stubGlobal('fetch', fetcher)
  await expect(
    streamAskAiWriter({
      baseUrl: 'http://localhost:11459',
      model: 'qwen3:4b-instruct',
      question: 'Who?',
      excerpts: [],
      onChunk: () => {}
    })
  ).resolves.toBe('Mira.')
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_BASE_URL', 'https://example.com')
  await expect(
    streamAskAiWriter({
      baseUrl: 'http://localhost:11459',
      model: 'qwen3:4b-instruct',
      question: 'Who?',
      excerpts: [],
      onChunk: () => {}
    })
  ).rejects.toThrow('loopback')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('does not feed unrelated transcript facts into a budget explanation when that meeting has budget evidence', () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_PROMPT', 'focused-stable')
  const prompt = buildWriterPrompt('Explain the Atlas and Harbor budget decisions.', [
    {
      meetingId: 'atlas',
      title: 'Atlas',
      date: 0,
      kind: 'note',
      text: 'Mira owns Atlas. The approved budget is $47,250. Launch is October 23.'
    },
    {
      meetingId: 'harbor',
      title: 'Harbor',
      date: 0,
      kind: 'note',
      text: 'Jon owns Harbor. The budget is $18,600. Launch is December 4.'
    },
    {
      meetingId: 'harbor',
      title: 'Harbor',
      date: 0,
      kind: 'transcript',
      text: 'Harbor uses two replicas.'
    }
  ])
  expect(prompt).toContain('$47,250')
  expect(prompt).toContain('$18,600')
  expect(prompt).not.toContain('two replicas')
  expect(prompt).not.toContain('owns Harbor')
})

it('preserves a rejection qualifier immediately after a matching proposal', () => {
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_PROMPT', 'focused-stable')
  const prompt = buildWriterPrompt('What budget was proposed?', [
    {
      meetingId: 'a',
      title: 'Earlier proposal',
      date: 0,
      kind: 'note',
      text: 'The proposed budget was $91,000. This proposal was rejected. Mira owns the launch.'
    }
  ])
  expect(prompt).toContain('This proposal was rejected.')
  expect(prompt).not.toContain('Mira owns')
})

it('preserves referenced source names in non-Latin conversational replies', async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    body: new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ message: { content: 'Atlasの予算です。' } }) + '\n'
          )
        )
        c.close()
      }
    })
  }))
  vi.stubGlobal('fetch', fetcher)
  await streamAskAiWriter({
    baseUrl: 'http://localhost:11434',
    model: 'test',
    question: 'What is the Atlas budget? Reply in Japanese.',
    language: 'ja',
    excerpts: [
      {
        meetingId: 'atlas',
        title: 'Atlas launch review',
        date: 0,
        kind: 'note',
        text: 'The budget is $47,250.'
      }
    ],
    conversation: { history: [], inventoryCount: 1, replyLanguage: 'ja' },
    onChunk: () => undefined
  })
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(String(call[1].body)).messages[1].content).toContain(
    'without transliteration: Atlas'
  )
})

it('preserves request bytes with experiment overrides unset and selecting the default writer', async () => {
  const bodies: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ message: { content: 'Mira owns Atlas.' }, done: true }) + '\n'
              )
            )
            controller.close()
          }
        })
      }
    })
  )
  const request = {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b-instruct',
    question: 'Who owns Atlas?',
    excerpts: [
      {
        meetingId: 'atlas',
        title: 'Atlas',
        date: 0,
        kind: 'note' as const,
        text: 'Mira owns Atlas.'
      }
    ],
    onChunk: vi.fn()
  }
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_MODEL', undefined)
  await streamAskAiWriter(request)
  await streamAskAiWriter({
    ...request,
    model: process.env.AUTODOC_ASK_AI_WRITER_MODEL ?? request.model
  })
  vi.stubEnv('AUTODOC_ASK_AI_WRITER_MODEL', 'qwen3:4b-instruct')
  await streamAskAiWriter({
    ...request,
    model: process.env.AUTODOC_ASK_AI_WRITER_MODEL ?? request.model
  })
  expect(bodies).toHaveLength(3)
  expect(bodies[1]).toBe(bodies[0])
  expect(bodies[2]).toBe(bodies[0])
})
