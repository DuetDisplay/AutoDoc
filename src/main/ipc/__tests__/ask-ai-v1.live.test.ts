/**
 * Ask AI v1 LIVE evaluation — the shipped classifier + planner path against a
 * real Ollama model, on the SAME fixtures and SAME 17 scenarios as
 * `ask-ai-agent.live.test.ts` (both import ../../services/__tests__/ask-ai-live-scenarios).
 *
 * This is the apples-to-apples baseline for the v2 agent. It exercises the real
 * `registerChatIpc` `chat:send-stream` handler (turn classifier, planner, lexical
 * + embedding retrieval, streaming answer) with NO fetch stub, so every model
 * round-trip and its latency is real. Gated + skipped unless AUTODOC_LIVE_EVAL=1.
 *
 *   AUTODOC_LIVE_EVAL=1 AUTODOC_ASK_AI_MODEL=llama3.1 \
 *   npm run test:main:run -- src/main/ipc/__tests__/ask-ai-v1.live.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  RECORDINGS,
  SCENARIOS,
  createRecording
} from '../../services/__tests__/ask-ai-live-scenarios'

const LIVE = process.env.AUTODOC_LIVE_EVAL === '1'
const BASE_URL = process.env.AUTODOC_OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = process.env.AUTODOC_ASK_AI_MODEL ?? 'llama3.1'
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-v1-eval')

vi.hoisted(() => {
  // Force the v1 path: the tool-calling agent must be OFF for this baseline.
  process.env.AUTODOC_ASK_AI_AGENT = '0'
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'autodoc-ask-ai-v1-live-userdata')) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'

interface CaseResult {
  scenario: string
  category: string
  question: string
  pass: boolean
  latencyMs: number
  answer: string
}

function getDoneContent(send: ReturnType<typeof vi.fn>, requestId: string): string {
  const done = send.mock.calls.find(
    ([channel, payload]) => channel === 'chat:done' && payload?.requestId === requestId
  )
  if (done) return done[1].content
  const err = send.mock.calls.find(
    ([channel, payload]) => channel === 'chat:error' && payload?.requestId === requestId
  )
  return err ? `__ERROR__: ${err[1].error}` : '__NO_RESPONSE__'
}

describe.skipIf(!LIVE)('Ask AI v1 LIVE eval', () => {
  let baseDir: string
  let streamHandler: (...args: unknown[]) => Promise<void>
  const results: CaseResult[] = []

  beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/api/tags`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!reachable) throw new Error(`Ollama not reachable at ${BASE_URL}. Start Ollama and retry.`)

    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-v1-live-'))
    for (const rec of RECORDINGS) await createRecording(baseDir, rec)

    registerChatIpc(
      baseDir,
      {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        isServerRunning: vi.fn().mockResolvedValue(true),
        getBaseUrl: () => BASE_URL
      },
      { getModel: () => MODEL } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1] as never
  }, 60_000)

  afterAll(async () => {
    if (results.length > 0) {
      await mkdir(REPORT_DIR, { recursive: true })
      const passed = results.filter((r) => r.pass).length
      const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b)
      const p = (q: number): number =>
        latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0
      const scorecard = {
        generatedAt: new Date().toISOString(),
        path: 'v1-classifier-planner',
        model: MODEL,
        total: results.length,
        passed,
        passRate: Math.round((passed / results.length) * 1000) / 10,
        latencyMs: { p50: p(0.5), p95: p(0.95), max: latencies[latencies.length - 1] ?? 0 },
        cases: results
      }
      await writeFile(join(REPORT_DIR, 'latest.json'), `${JSON.stringify(scorecard, null, 2)}\n`)
      console.log(
        [
          '',
          `════════ Ask AI V1 live eval (model=${MODEL}) ════════`,
          `Pass rate: ${scorecard.passRate}%  (${passed}/${results.length})`,
          `Latency ms: p50=${scorecard.latencyMs.p50} p95=${scorecard.latencyMs.p95} max=${scorecard.latencyMs.max}`,
          ...results
            .filter((r) => !r.pass)
            .map(
              (r) =>
                `  ❌ [${r.category}] ${r.scenario}: "${r.question}" → ${r.answer.slice(0, 80).replace(/\n/g, ' ')}`
            ),
          '═══════════════════════════════════════════'
        ].join('\n')
      )
    }
    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  it('runs the live scenario matrix through v1 and writes a scorecard', async () => {
    let senderId = 5000
    for (const scenario of SCENARIOS) {
      senderId += 1
      const sender = { id: senderId, send: vi.fn() }
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

      for (let i = 0; i < scenario.turns.length; i++) {
        const turn = scenario.turns[i]
        const requestId = `${scenario.id}-${i}`
        const startedAt = Date.now()
        await streamHandler({ sender } as never, requestId, turn.question, history.slice(-8))
        const latencyMs = Date.now() - startedAt
        const answer = getDoneContent(sender.send, requestId)

        history.push({ role: 'user', content: turn.question })
        history.push({ role: 'assistant', content: answer })

        results.push({
          scenario: scenario.id,
          category: scenario.category,
          question: turn.question,
          pass: turn.check(answer),
          latencyMs,
          answer
        })
      }
    }
    expect(results.length).toBeGreaterThan(0)
  }, 600_000)
})
