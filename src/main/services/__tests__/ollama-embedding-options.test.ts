import { afterEach, expect, it, vi } from 'vitest'
import { OllamaEmbeddingProvider } from '../ollama-embedding'
afterEach(() => vi.unstubAllGlobals())
it('preserves the default embedding request used by existing callers', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 })
  )
  vi.stubGlobal('fetch', fetch)
  await new OllamaEmbeddingProvider('http://localhost:11435', 'test').embed(['A note.'])
  const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
  expect(body).not.toHaveProperty('options')
  expect(body.keep_alive).toBe('10m')
})
it('can force CPU embedding and unload afterward for the Windows experiment', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 })
  )
  vi.stubGlobal('fetch', fetch)
  await new OllamaEmbeddingProvider('http://localhost:11435', 'test', { num_gpu: 0 }, 0).embed([
    'A note.'
  ])
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
    options: { num_gpu: 0 },
    keep_alive: 0,
    input: ['A note.']
  })
})
