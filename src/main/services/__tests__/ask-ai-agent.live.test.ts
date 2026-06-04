/**
 * Ask AI agent (v2) LIVE evaluation — head-to-head against a real Ollama model.
 *
 * This is the benchmark we cannot run in CI (no local model), so it is GATED and
 * skipped by default. It seeds deterministic fixture recordings, then runs the
 * tool-calling agent against your real Ollama for a matrix of scenarios that
 * mirror the AD-83 failure classes (counts, ordinals, skepticism, quantity-vs-
 * ordinal, search). For each scenario it records pass/fail against a ground-truth
 * predicate and the wall-clock latency, then writes a scorecard.
 *
 * Run it locally with Ollama running:
 *
 *   AUTODOC_LIVE_EVAL=1 \
 *   AUTODOC_ASK_AI_MODEL=llama3.1 \
 *   npm run test:main:run -- src/main/services/__tests__/ask-ai-agent.live.test.ts
 *
 * Compare the printed pass-rate + latency against the v1 routing benchmark
 * scorecard in artifacts/ask-ai-benchmark/scorecard.md before deciding to flip
 * AUTODOC_ASK_AI_AGENT on by default.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatRecordingIndex } from '../chat-retrieval'
import { runAskAiAgent, type AgentSession, type AgentToolDeps } from '../ask-ai-agent'
import { RECORDINGS, SCENARIOS, createRecording } from './ask-ai-live-scenarios'

const LIVE = process.env.AUTODOC_LIVE_EVAL === '1'
const BASE_URL = process.env.AUTODOC_OLLAMA_URL ?? 'http://localhost:11434'
const MODEL = process.env.AUTODOC_ASK_AI_MODEL ?? 'llama3.1'
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-agent-eval')

interface CaseResult {
  scenario: string
  category: string
  question: string
  pass: boolean
  latencyMs: number
  toolCalls: string[]
  answer: string
}

describe.skipIf(!LIVE)('Ask AI agent LIVE eval', () => {
  let baseDir: string
  let index: ChatRecordingIndex
  let deps: AgentToolDeps
  const results: CaseResult[] = []

  beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/api/tags`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!reachable) throw new Error(`Ollama not reachable at ${BASE_URL}. Start Ollama and retry.`)

    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-agent-live-'))
    for (const rec of RECORDINGS) await createRecording(baseDir, rec)
    index = new ChatRecordingIndex(baseDir, { watch: false })
    deps = {
      recordingIndex: index,
      loadCalendar: async () => ({ recentEvents: [], upcomingEvents: [] }),
      rememberRecordingList: (session, ids, titles) => {
        session.lastRecordingIds = ids
        session.lastRecordingTitles = ids.map((_, i) => titles[i] ?? '')
      }
    }
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
          `════════ Ask AI AGENT live eval (model=${MODEL}) ════════`,
          `Pass rate: ${scorecard.passRate}%  (${passed}/${results.length})`,
          `Latency ms: p50=${scorecard.latencyMs.p50} p95=${scorecard.latencyMs.p95} max=${scorecard.latencyMs.max}`,
          ...results
            .filter((r) => !r.pass)
            .map(
              (r) =>
                `  ❌ [${r.category}] ${r.scenario}: "${r.question}" tools=[${r.toolCalls.join(',')}] → ${r.answer.slice(0, 80).replace(/\n/g, ' ')}`
            ),
          '═══════════════════════════════════════════'
        ].join('\n')
      )
    }
    if (index) index.dispose()
    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  it('runs the live scenario matrix and writes a scorecard', async () => {
    for (const scenario of SCENARIOS) {
      const session: AgentSession = {
        lastRecordingIds: [],
        lastRecordingTitles: [],
        lastCalendarEvents: [],
        focusedRecordingIds: []
      }
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

      for (const turn of scenario.turns) {
        const startedAt = Date.now()
        const agentResult = await runAskAiAgent({
          baseUrl: BASE_URL,
          model: MODEL,
          question: turn.question,
          history: history.slice(-8),
          session,
          deps,
          onChunk: () => {}
        })
        const latencyMs = Date.now() - startedAt
        history.push({ role: 'user', content: turn.question })
        history.push({ role: 'assistant', content: agentResult.answer })

        results.push({
          scenario: scenario.id,
          category: scenario.category,
          question: turn.question,
          pass: turn.check(agentResult.answer),
          latencyMs,
          toolCalls: agentResult.toolCalls.map((t) => t.name),
          answer: agentResult.answer
        })
      }
    }
    expect(results.length).toBeGreaterThan(0)
  }, 600_000)
})
