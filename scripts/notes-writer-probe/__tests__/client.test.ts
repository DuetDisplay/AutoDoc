import { describe, expect, it } from 'vitest'

import { DEFAULT_SEED, STOP_CONDITIONS } from '../constants.ts'
import { generateBody, OllamaClient } from '../ollama-client.ts'

describe('ollama client request shaping', () => {
  it('builds a generate body with ctx, predict, temperature, and seed', () => {
    const body = generateBody({
      model: 'llama3.1:latest',
      prompt: 'Reply with the single word: ready',
      stream: true,
      options: {
        num_ctx: 2048,
        num_predict: 10,
        temperature: 0,
        seed: DEFAULT_SEED,
        stop: STOP_CONDITIONS
      }
    })
    expect(body).toEqual({
      model: 'llama3.1:latest',
      prompt: 'Reply with the single word: ready',
      stream: true,
      options: {
        num_ctx: 2048,
        num_predict: 10,
        temperature: 0,
        seed: 42
      }
    })
  })

  it('includes stop only when preregistered stop strings exist', () => {
    const body = generateBody({
      model: 'llama3.1:latest',
      prompt: 'x',
      stream: false,
      options: {
        num_ctx: 8,
        num_predict: 1,
        temperature: 0.4,
        seed: 1,
        stop: ['END']
      }
    })
    expect(body.stream).toBe(false)
    expect(body.options).toMatchObject({ stop: ['END'], temperature: 0.4 })
  })

  it('posts /api/generate and captures non-streaming timings', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(
        JSON.stringify({
          response: 'ready',
          done: true,
          done_reason: 'stop',
          total_duration: 2_000_000_000,
          load_duration: 500_000_000,
          prompt_eval_count: 12,
          prompt_eval_duration: 800_000_000,
          eval_count: 1,
          eval_duration: 200_000_000
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    const client = new OllamaClient('127.0.0.1:11438', { fetch: fetchImpl })
    const result = await client.generate({
      model: 'llama3.1:latest',
      prompt: 'Reply with the single word: ready',
      stream: false,
      options: {
        num_ctx: 2048,
        num_predict: 10,
        temperature: 0,
        seed: 42,
        stop: []
      }
    })
    expect(calls[0]?.url).toBe('http://127.0.0.1:11438/api/generate')
    expect(calls[0]?.body).toMatchObject({
      model: 'llama3.1:latest',
      stream: false,
      options: { num_ctx: 2048, num_predict: 10, temperature: 0, seed: 42 }
    })
    expect(result.text).toBe('ready')
    expect(result.timings.loadDurationMs).toBe(500)
    expect(result.timings.promptEvalDurationMs).toBe(800)
    expect(result.timings.evalDurationMs).toBe(200)
    expect(result.timings.promptEvalCount).toBe(12)
    expect(result.timings.evalCount).toBe(1)
  })

  it('concatenates streaming generate chunks and keeps raw bytes', async () => {
    const payload =
      `${JSON.stringify({ response: 're', done: false })}\n` +
      `${JSON.stringify({
        response: 'ady',
        done: true,
        done_reason: 'stop',
        total_duration: 1_000_000_000,
        load_duration: 100_000_000,
        prompt_eval_count: 4,
        prompt_eval_duration: 200_000_000,
        eval_count: 2,
        eval_duration: 300_000_000
      })}\n`
    const fetchImpl: typeof fetch = async () =>
      new Response(payload, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    const client = new OllamaClient('http://127.0.0.1:11438', { fetch: fetchImpl })
    const result = await client.generate({
      model: 'llama3.1:latest',
      prompt: 'x',
      stream: true,
      options: {
        num_ctx: 2048,
        num_predict: 10,
        temperature: 0,
        seed: 42,
        stop: []
      }
    })
    expect(result.text).toBe('ready')
    expect(result.rawBody).toBe(payload)
    expect(result.timings.evalCount).toBe(2)
  })
})
