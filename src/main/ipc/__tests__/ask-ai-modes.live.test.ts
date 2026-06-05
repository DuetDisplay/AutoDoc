/**
 * Ask AI head-to-head LIVE eval across all three routing modes — v1
 * (classifier + planner), agent (tool-calling v2), and hybrid — driven through
 * the SAME `registerChatIpc` `chat:send-stream` entry point on the SAME fixtures
 * and the SAME scenario matrix (../../services/__tests__/ask-ai-live-scenarios).
 *
 * This is the apples-to-apples benchmark for the hybrid router: it proves the
 * hybrid keeps v1's instant deterministic answers where they're reliable while
 * inheriting the agent's robustness on conversational / open-ended turns, with
 * no correctness regression versus either baseline.
 *
 * Gated + skipped unless AUTODOC_LIVE_EVAL=1. Each round-trip is real (no fetch
 * stub) so latency is measured against a real Ollama model.
 *
 *   AUTODOC_LIVE_EVAL=1 AUTODOC_ASK_AI_MODEL=llama3.1 \
 *   npm run test:main:run -- src/main/ipc/__tests__/ask-ai-modes.live.test.ts
 *
 * Limit modes with AUTODOC_ASK_AI_EVAL_MODES=hybrid,v1 (comma separated).
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
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-hybrid-eval')

type Mode = 'v1' | 'hybrid' | 'agent'
const VALID_MODES: Mode[] = ['v1', 'hybrid', 'agent']
const requestedModes = process.env.AUTODOC_ASK_AI_EVAL_MODES?.split(',')
  .map((m) => m.trim())
  .filter((m): m is Mode => (VALID_MODES as string[]).includes(m))
const MODES: Mode[] = requestedModes && requestedModes.length > 0 ? requestedModes : VALID_MODES

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'autodoc-ask-ai-modes-userdata')) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

type StreamHandler = (
  event: unknown,
  requestId: string,
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
) => Promise<void>

interface CaseResult {
  mode: Mode
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

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10)

describe.skipIf(!LIVE)('Ask AI modes LIVE eval (v1 vs hybrid vs agent)', () => {
  let baseDir: string
  const results: CaseResult[] = []

  beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/api/tags`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!reachable) throw new Error(`Ollama not reachable at ${BASE_URL}. Start Ollama and retry.`)
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-modes-'))
    for (const rec of RECORDINGS) await createRecording(baseDir, rec)
  }, 60_000)

  afterAll(async () => {
    if (results.length === 0) return
    await mkdir(REPORT_DIR, { recursive: true })

    const summarize = (mode: Mode): Record<string, unknown> => {
      const rows = results.filter((r) => r.mode === mode)
      const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b)
      const p = (q: number): number =>
        lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0
      return {
        mode,
        total: rows.length,
        passed: rows.filter((r) => r.pass).length,
        passRate: pct(rows.filter((r) => r.pass).length, rows.length),
        latencyMs: { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] ?? 0 },
        instantTurns: rows.filter((r) => r.latencyMs < 1000).length
      }
    }

    const comparison = {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      modes: MODES.map(summarize),
      cases: results
    }
    await writeFile(join(REPORT_DIR, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)

    const lines: string[] = ['', `════════ Ask AI modes live eval (model=${MODEL}) ════════`]
    for (const mode of MODES) {
      const s = summarize(mode) as {
        passed: number
        total: number
        passRate: number
        latencyMs: { p50: number; p95: number; max: number }
        instantTurns: number
      }
      lines.push(
        `${mode.toUpperCase().padEnd(7)} pass ${s.passed}/${s.total} (${s.passRate}%)  ` +
          `lat p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms max=${s.latencyMs.max}ms  ` +
          `instant(<1s)=${s.instantTurns}/${s.total}`
      )
    }
    for (const mode of MODES) {
      const fails = results.filter((r) => r.mode === mode && !r.pass)
      for (const f of fails) {
        lines.push(
          `  ❌ [${mode}/${f.category}] ${f.scenario}: "${f.question}" → ${f.answer
            .slice(0, 80)
            .replace(/\n/g, ' ')}`
        )
      }
    }
    lines.push('═══════════════════════════════════════════')
    console.log(lines.join('\n'))

    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  async function loadHandlerForMode(mode: Mode): Promise<StreamHandler> {
    vi.resetModules()
    process.env.AUTODOC_ASK_AI_MODE = mode
    delete process.env.AUTODOC_ASK_AI_AGENT
    const { ipcMain } = await import('electron')
    vi.mocked(ipcMain.handle).mockClear()
    const { registerChatIpc } = await import('../chat-ipc')
    registerChatIpc(
      baseDir,
      {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        isServerRunning: vi.fn().mockResolvedValue(true),
        getBaseUrl: () => BASE_URL
      } as never,
      { getModel: () => MODEL } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1]
    if (!handler) {
      throw new Error('registerChatIpc did not register chat:send-stream')
    }
    return handler as never
  }

  for (const mode of MODES) {
    it(`runs the scenario matrix in ${mode} mode`, async () => {
      const streamHandler = await loadHandlerForMode(mode)
      let senderId = mode === 'v1' ? 1000 : mode === 'hybrid' ? 2000 : 3000

      for (const scenario of SCENARIOS) {
        senderId += 1
        const sender = { id: senderId, send: vi.fn() }
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

        for (let i = 0; i < scenario.turns.length; i++) {
          const turn = scenario.turns[i]
          const requestId = `${mode}-${scenario.id}-${i}`
          const startedAt = Date.now()
          await streamHandler({ sender }, requestId, turn.question, history.slice(-8))
          const latencyMs = Date.now() - startedAt
          const answer = getDoneContent(sender.send, requestId)

          history.push({ role: 'user', content: turn.question })
          history.push({ role: 'assistant', content: answer })

          results.push({
            mode,
            scenario: scenario.id,
            category: scenario.category,
            question: turn.question,
            pass: turn.check(answer),
            latencyMs,
            answer
          })
        }
      }
      expect(results.filter((r) => r.mode === mode).length).toBeGreaterThan(0)
    }, 900_000)
  }
})
