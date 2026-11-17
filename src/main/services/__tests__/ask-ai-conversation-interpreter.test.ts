import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
import {
  ConversationInterpretationError,
  interpretConversation
} from '../ask-ai-conversation-interpreter'
const input = {
  baseUrl: 'http://localhost:11434',
  model: 'test',
  question: 'What did they choose?',
  history: [],
  fallbackLanguage: 'en',
  numCtx: 1024
}
afterEach(() => vi.unstubAllGlobals())
it('keeps semantic operations constrained and uses the existing selected context', async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      message: {
        content: JSON.stringify({
          operation: 'search',
          subject: 'Ridge',
          query: 'What did Ridge choose?',
          language: 'en',
          clarification: ''
        })
      }
    })
  }))
  vi.stubGlobal('fetch', fetch)
  const result = await interpretConversation({
    ...input,
    history: [{ role: 'user', content: 'Tell me about Ridge.' }]
  })
  expect(result.subject).toBe('Ridge')
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const body = JSON.parse(String(call[1].body))
  expect(body.options.num_ctx).toBe(1024)
  expect(body.format.properties.operation.enum).toEqual(['search', 'clarify', 'count', 'list'])
  expect(body.messages[0].content).toContain('Topic/date-filtered counts')
})
it.each([
  'not json',
  JSON.stringify({ operation: 'search', subject: '', query: '', language: 'en', clarification: '' })
])(
  'classifies malformed/incomplete output for safe clarification without recording its contents',
  async (content) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ message: { content } }) }))
    )
    await expect(interpretConversation(input)).rejects.toBeInstanceOf(
      ConversationInterpretationError
    )
  }
)
it('does not turn an HTTP runtime failure into a question clarification', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 503 }))
  )
  try {
    await interpretConversation(input)
    throw Error('expected runtime failure')
  } catch (error) {
    expect(error).not.toBeInstanceOf(ConversationInterpretationError)
    expect(String(error)).toContain('503')
  }
})
