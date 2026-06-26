/**
 * FRESH usability probe (hybrid only) — runs the 50 unseen scenarios in
 * `ask-ai-fresh-scenarios.ts` through the same `chat:send-stream` entry point in
 * HYBRID mode (the shipping default) against the same 4 fixtures. Estimates how
 * often a real user hits an edge case vs a correct answer on input we did NOT
 * design the system around.
 *
 * Gated + skipped unless AUTODOC_LIVE_EVAL=1 (real Ollama round-trips):
 *   AUTODOC_LIVE_EVAL=1 AUTODOC_ASK_AI_MODEL=llama3.1 \
 *   npm run test:main:run -- src/main/ipc/__tests__/ask-ai-fresh.live.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RECORDINGS, createRecording } from '../../services/__tests__/ask-ai-live-scenarios'
import { FRESH_SCENARIOS } from '../../services/__tests__/ask-ai-fresh-scenarios'

const LIVE = process.env.AUTODOC_LIVE_EVAL === '1'
const BASE_URL = process.env.AUTODOC_OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = process.env.AUTODOC_ASK_AI_MODEL ?? 'llama3.1'
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-fresh-eval')

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'autodoc-ask-ai-fresh-userdata')) },
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
  scenario: string
  category: string
  question: string
  graded: boolean
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

describe.skipIf(!LIVE)('Ask AI FRESH usability probe (hybrid)', () => {
  let baseDir: string
  const results: CaseResult[] = []

  beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/api/tags`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!reachable) throw new Error(`Ollama not reachable at ${BASE_URL}. Start Ollama and retry.`)
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-fresh-'))
    for (const rec of RECORDINGS) await createRecording(baseDir, rec)
  }, 60_000)

  afterAll(async () => {
    if (results.length === 0) return
    await mkdir(REPORT_DIR, { recursive: true })

    const graded = results.filter((r) => r.graded)
    const lat = graded.map((r) => r.latencyMs).sort((a, b) => a - b)
    const p = (q: number): number => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0
    const passed = graded.filter((r) => r.pass).length

    const byCategory: Record<string, { passed: number; total: number }> = {}
    for (const r of graded) {
      byCategory[r.category] ??= { passed: 0, total: 0 }
      byCategory[r.category].total += 1
      if (r.pass) byCategory[r.category].passed += 1
    }

    await writeFile(
      join(REPORT_DIR, 'comparison.json'),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          model: MODEL,
          mode: 'hybrid',
          gradedTotal: graded.length,
          gradedPassed: passed,
          passRate: pct(passed, graded.length),
          latencyMs: { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] ?? 0 },
          instantTurns: graded.filter((r) => r.latencyMs < 1000).length,
          byCategory,
          cases: results
        },
        null,
        2
      )}\n`
    )

    const lines: string[] = [
      '',
      `════════ Ask AI FRESH usability probe (mode=hybrid, model=${MODEL}) ════════`,
      `GRADED pass ${passed}/${graded.length} (${pct(passed, graded.length)}%)  ` +
        `lat p50=${p(0.5)}ms p95=${p(0.95)}ms max=${lat[lat.length - 1] ?? 0}ms  ` +
        `instant(<1s)=${graded.filter((r) => r.latencyMs < 1000).length}/${graded.length}`,
      '— by category —'
    ]
    for (const [cat, s] of Object.entries(byCategory).sort()) {
      lines.push(`  ${cat.padEnd(16)} ${s.passed}/${s.total} (${pct(s.passed, s.total)}%)`)
    }
    lines.push('— failures —')
    for (const f of graded.filter((r) => !r.pass)) {
      lines.push(
        `  ❌ [${f.category}] ${f.scenario}: "${f.question}" → ${f.answer.slice(0, 90).replace(/\n/g, ' ')}`
      )
    }
    lines.push('═══════════════════════════════════════════')
    console.log(lines.join('\n'))

    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  async function loadHybridHandler(): Promise<StreamHandler> {
    vi.resetModules()
    process.env.AUTODOC_ASK_AI_MODE = 'hybrid'
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

  it('runs the fresh scenario set in hybrid mode', async () => {
    const streamHandler = await loadHybridHandler()
    let senderId = 5000

    for (const scenario of FRESH_SCENARIOS) {
      senderId += 1
      const sender = { id: senderId, send: vi.fn() }
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

      for (let i = 0; i < scenario.turns.length; i++) {
        const turn = scenario.turns[i]
        const requestId = `fresh-${scenario.id}-${i}`
        // A turn whose predicate is the trivial () => true is a conversational
        // setup step (provides an antecedent for the graded follow-up); exclude
        // it from the scored denominator so the pass-rate reflects real asks.
        // Every real grader returns false on an empty string, so this cleanly
        // identifies the setup turns.
        const isSetup = turn.check('') === true
        const startedAt = Date.now()
        await streamHandler({ sender }, requestId, turn.question, history.slice(-8))
        const latencyMs = Date.now() - startedAt
        const answer = getDoneContent(sender.send, requestId)

        history.push({ role: 'user', content: turn.question })
        history.push({ role: 'assistant', content: answer })

        results.push({
          scenario: scenario.id,
          category: scenario.category,
          question: turn.question,
          graded: !isSetup,
          pass: turn.check(answer),
          latencyMs,
          answer
        })
      }
    }
    expect(results.length).toBeGreaterThan(0)
  }, 1_200_000)
})
