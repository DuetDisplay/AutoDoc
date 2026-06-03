/**
 * Ask AI routing benchmark (AD-83).
 *
 * This is a re-runnable, deterministic benchmark for the Ask AI *routing* layer
 * (the deterministic pre-model decisions in `prepareChatContext`: acknowledgements,
 * count confirmations, ordinal/coreference follow-ups, direct list/count, exact-title,
 * conversation scoping, and the fast retrieval plan).
 *
 * It is intentionally offline and deterministic:
 *   - the model planner is disabled (AUTODOC_ASK_AI_PLANNER=0)
 *   - embeddings are disabled (AUTODOC_ASK_AI_EMBEDDINGS=0) so retrieval is lexical
 *   - `fetch` is stubbed to echo which recordings were placed in model context
 *
 * Each case encodes *ground-truth* expected behavior (not a snapshot of current
 * behavior), so some cases are expected to FAIL on the current implementation.
 * Those failures are the measured gaps. After the holistic refactor, re-run and
 * confirm the gaps flip to PASS with zero regressions on previously-passing cases.
 *
 * Run:        npm run test:main:run -- src/main/ipc/__tests__/ask-ai-routing.benchmark.test.ts
 * Save base:  BENCH_SAVE_BASELINE=1 npm run test:main:run -- src/main/ipc/__tests__/ask-ai-routing.benchmark.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MeetingMetadata, MeetingSegments } from '../../../shared/types'

vi.hoisted(() => {
  process.env.AUTODOC_ASK_AI_PLANNER = '0'
  process.env.AUTODOC_ASK_AI_EMBEDDINGS = '0'
})

const capturedEvents: Array<{ message: string; context: Record<string, unknown> }> = []

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'autodoc-ask-ai-bench-userdata')) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn((entry: { message: string; context?: Record<string, unknown> }) => {
    capturedEvents.push({ message: entry.message, context: entry.context ?? {} })
  }),
  logAutodocFailure: vi.fn()
}))

import { ipcMain } from 'electron'
import { registerChatIpc } from '../chat-ipc'

// ---------------------------------------------------------------------------
// Fixture recordings (ordered most-recent-first when listed): 1..4
// ---------------------------------------------------------------------------
interface FixtureRecording {
  id: string
  startedAt: number
  sourceName: string
  notes: string
  noteCategory?: keyof MeetingSegments
  /** distinctive lowercase token found in the title */
  titleToken: string
  /** distinctive lowercase token found only in this recording's notes */
  noteToken: string
}

const RECORDINGS: FixtureRecording[] = [
  {
    id: 'ad83-001-roadmap',
    startedAt: new Date(2026, 5, 1, 10, 0).getTime(),
    sourceName: 'AD83 Fixture - Roadmap Review',
    notes: 'Roadmap sequencing for Q3 was locked. Priya will drive the milestone tracker.',
    titleToken: 'roadmap',
    noteToken: 'sequencing'
  },
  {
    id: 'ad83-002-support',
    startedAt: new Date(2026, 5, 1, 9, 0).getTime(),
    sourceName: 'AD83 Fixture - Support Triage',
    notes: 'Casey owns the escalation follow-up for the priority customer queue.',
    noteCategory: 'actionItems',
    titleToken: 'support',
    noteToken: 'escalation'
  },
  {
    id: 'ad83-003-design',
    startedAt: new Date(2026, 5, 1, 8, 0).getTime(),
    sourceName: 'AD83 Fixture - Design Sync',
    notes: 'The team rewrote the onboarding copy and chose the calmer illustration set.',
    titleToken: 'design',
    noteToken: 'onboarding'
  },
  {
    id: 'ad83-004-calendar',
    startedAt: new Date(2026, 5, 1, 7, 0).getTime(),
    sourceName: 'AD83 Fixture - Calendar Auth Review',
    notes: 'Google Calendar OAuth scopes need a consent-screen update before launch.',
    titleToken: 'calendar auth',
    noteToken: 'consent-screen'
  }
]

// ---------------------------------------------------------------------------
// Outcome + scoring types
// ---------------------------------------------------------------------------
interface TurnOutcome {
  question: string
  answer: string
  modelInvoked: boolean
  route: string
}

type Check = (o: TurnOutcome) => boolean

interface TurnSpec {
  question: string
  /** ground-truth expectation for this turn */
  check: Check
  /** human description of the expected behavior */
  expectation: string
}

interface Scenario {
  id: string
  category: string
  /** prior assistant/user turns to seed (besides those produced during the run) */
  seedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  turns: TurnSpec[]
}

interface CaseResult {
  scenario: string
  category: string
  question: string
  expectation: string
  pass: boolean
  answer: string
  route: string
  modelInvoked: boolean
}

// ---------------------------------------------------------------------------
// Ground-truth predicate helpers
// ---------------------------------------------------------------------------
const lc = (s: string): string => s.toLowerCase()

function isWelcome(o: TurnOutcome): boolean {
  return /you're welcome|you are welcome/i.test(o.answer)
}

function notWelcome(o: TurnOutcome): boolean {
  return !isWelcome(o)
}

/** Answer references the given recordings and none of the others (by note/title token). */
function scopedTo(...ids: string[]): Check {
  const expected = RECORDINGS.filter((r) => ids.includes(r.id))
  const others = RECORDINGS.filter((r) => !ids.includes(r.id))
  return (o) => {
    const text = lc(o.answer)
    const hitsExpected = expected.every(
      (r) => text.includes(r.noteToken) || text.includes(r.titleToken)
    )
    const leaksOther = others.some((r) => text.includes(r.noteToken))
    return hitsExpected && !leaksOther
  }
}

/** Answer references the given recordings (no exclusion of others). */
function mentions(...ids: string[]): Check {
  const expected = RECORDINGS.filter((r) => ids.includes(r.id))
  return (o) => {
    const text = lc(o.answer)
    return expected.every((r) => text.includes(r.noteToken) || text.includes(r.titleToken))
  }
}

function countConfirm(
  actual: number,
  label: 'local recording' | 'calendar meeting',
  correct: boolean
): Check {
  return (o) => {
    const text = lc(o.answer)
    const plural = `${label}${actual === 1 ? '' : 's'}`
    const mentionsCount = text.includes(`${actual} ${plural}`)
    const polarityOk = correct ? text.includes('yes, you have') : text.includes('not quite')
    return mentionsCount && polarityOk
  }
}

function deterministic(check: Check): Check {
  return (o) => !o.modelInvoked && check(o)
}

// ---------------------------------------------------------------------------
// The benchmark matrix. Cases marked GAP are expected to fail pre-refactor.
// ---------------------------------------------------------------------------
const SCENARIOS: Scenario[] = [
  // --- A. Direct inventory (baseline) ---
  {
    id: 'list-recordings',
    category: 'direct-inventory',
    turns: [
      {
        question: 'list my recordings',
        expectation: 'Lists all 4 recordings directly, no model',
        check: deterministic((o) => /i found 4 recordings total/i.test(o.answer))
      }
    ]
  },
  {
    id: 'count-recordings',
    category: 'direct-inventory',
    turns: [
      {
        question: 'how many recordings do I have?',
        expectation: 'Answers "You have 4 recordings." directly, no model',
        check: deterministic((o) => /you have 4 recordings\./i.test(o.answer))
      }
    ]
  },

  // --- B. Acknowledgements ---
  {
    id: 'ack-thanks',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'thanks!',
        expectation: 'Acknowledged with no retrieval/model',
        check: deterministic(isWelcome)
      }
    ]
  },
  {
    id: 'ack-ok-cool',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'ok cool',
        expectation: 'Acknowledged with no retrieval/model',
        check: deterministic(isWelcome)
      }
    ]
  },
  {
    id: 'ack-cheers-GAP',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'cheers',
        expectation: 'GAP: "cheers" should be treated as an acknowledgement',
        check: deterministic(isWelcome)
      }
    ]
  },
  {
    id: 'ack-ty-no-worries-GAP',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'no worries, ty',
        expectation: 'GAP: casual "no worries, ty" should be an acknowledgement',
        check: deterministic(isWelcome)
      }
    ]
  },
  {
    id: 'ack-much-appreciated-GAP',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'much appreciated',
        expectation: 'GAP: "much appreciated" should be an acknowledgement',
        check: deterministic(isWelcome)
      }
    ]
  },
  {
    id: 'ack-not-mixed-request',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'thanks, can you show action items?',
        expectation: 'Mixed thanks+request must NOT be swallowed; surfaces action items (Support)',
        check: (o) => notWelcome(o) && mentions('ad83-002-support')(o)
      }
    ]
  },

  // --- B2. Greetings / small talk (must be instant, no model) ---
  {
    id: 'greeting-hey',
    category: 'smalltalk',
    turns: [
      {
        question: 'hey',
        expectation: 'Greeting answered instantly with no retrieval/model',
        check: deterministic((o) => /ask me anything about your meetings/i.test(o.answer))
      }
    ]
  },
  {
    id: 'greeting-good-morning',
    category: 'smalltalk',
    turns: [
      {
        question: 'good morning!',
        expectation: 'Greeting answered instantly with no retrieval/model',
        check: deterministic((o) => /ask me anything about your meetings/i.test(o.answer))
      }
    ]
  },
  {
    id: 'capability-question',
    category: 'smalltalk',
    turns: [
      {
        question: 'what can you do?',
        expectation: 'Capability question answered instantly with no retrieval/model',
        check: deterministic((o) => /meeting assistant/i.test(o.answer))
      }
    ]
  },
  {
    id: 'greeting-with-request-not-smalltalk',
    category: 'smalltalk',
    turns: [
      {
        question: 'hey, what did we discuss in the design sync?',
        expectation: 'A greeting glued to a real request routes to retrieval, not small talk',
        check: (o) =>
          o.route !== 'smalltalk' && !/ask me anything about your meetings/i.test(o.answer)
      }
    ]
  },

  // --- C. Count confirmations (after listing 4 recordings) ---
  {
    id: 'count-confirm-four',
    category: 'count-confirmation',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'so four then?',
        expectation: 'Confirms 4 recordings from session state, no model',
        check: deterministic(countConfirm(4, 'local recording', true))
      }
    ]
  },
  {
    id: 'count-confirm-five-wrong',
    category: 'count-confirmation',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'so five total?',
        expectation: 'Corrects to 4 recordings from session state, no model',
        check: deterministic(countConfirm(4, 'local recording', false))
      }
    ]
  },
  {
    id: 'count-confirm-is-that-all-GAP',
    category: 'count-confirmation',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'is that all of them?',
        expectation: 'GAP: "is that all" should confirm the count from session state',
        check: deterministic(countConfirm(4, 'local recording', true))
      }
    ]
  },
  {
    id: 'count-confirm-only-four-GAP',
    category: 'count-confirmation',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'only 4?',
        expectation: 'GAP: "only 4?" should confirm the count from session state',
        check: deterministic(countConfirm(4, 'local recording', true))
      }
    ]
  },

  // --- D. Ordinal / coreference follow-ups (after listing) ---
  {
    id: 'ordinal-second',
    category: 'coreference',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'show notes for the second one',
        expectation: 'Resolves to 2nd listed recording (Support Triage)',
        check: scopedTo('ad83-002-support')
      }
    ]
  },
  {
    id: 'ordinal-third',
    category: 'coreference',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'summarize the third one',
        expectation: 'Resolves to 3rd listed recording (Design Sync)',
        check: scopedTo('ad83-003-design')
      }
    ]
  },
  {
    id: 'ordinal-last-GAP',
    category: 'coreference',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'show notes for the last one',
        expectation:
          'GAP: "the last one" should resolve to the 4th listed recording (Calendar Auth)',
        check: scopedTo('ad83-004-calendar')
      }
    ]
  },
  {
    id: 'title-ref-GAP',
    category: 'coreference',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'tell me about the calendar auth one',
        expectation: 'GAP: title-style reference should resolve to Calendar Auth Review',
        check: scopedTo('ad83-004-calendar')
      }
    ]
  },

  // --- E. Quantity-as-ordinal false positives (HIGH severity) ---
  {
    id: 'quantity-top-3-from-support-GAP',
    category: 'quantity-vs-ordinal',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'what are the top 3 action items from the support meeting?',
        expectation:
          'GAP: "3" is a quantity, not an ordinal; must scope to Support, not the 3rd recording',
        check: scopedTo('ad83-002-support')
      }
    ]
  },
  {
    id: 'quantity-2-takeaways-roadmap-GAP',
    category: 'quantity-vs-ordinal',
    turns: [
      { question: 'list my recordings', expectation: 'list', check: () => true },
      {
        question: 'give me 2 takeaways from the roadmap review',
        expectation:
          'GAP: "2" is a quantity, not an ordinal; must scope to Roadmap, not the 2nd recording',
        check: scopedTo('ad83-001-roadmap')
      }
    ]
  },

  // --- F. Affirmation must not be swallowed as thanks (HIGH severity) ---
  {
    id: 'yes-after-clarification-GAP',
    category: 'affirmation',
    seedHistory: [
      { role: 'user', content: 'pull up the roadmap meeting' },
      {
        role: 'assistant',
        content:
          'I found a few possible matching meetings. Which one should I use? 1. Roadmap Review 2. Design Sync'
      }
    ],
    turns: [
      {
        question: 'yes the first one',
        expectation:
          'GAP: an affirmation answering a clarification must NOT return "You\'re welcome."',
        check: notWelcome
      }
    ]
  },

  // --- G. New search after a prior selection must not pin (regression guard) ---
  {
    id: 'new-search-not-pinned',
    category: 'scope-isolation',
    turns: [
      {
        question: 'summarize the design sync',
        expectation: 'Scopes to Design Sync',
        check: scopedTo('ad83-003-design')
      },
      {
        question: 'who owns the escalation follow-up?',
        expectation: 'New question must retrieve Support Triage, not stay pinned to Design Sync',
        check: scopedTo('ad83-002-support')
      }
    ]
  }
]

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function deriveRoute(events: Array<{ message: string; context: Record<string, unknown> }>): string {
  const routed = events.find((e) => e.message === 'chat routed without retrieval')
  if (routed) return String(routed.context.route ?? 'routed')

  const retrieval = events.find((e) => e.message === 'chat retrieval completed')
  if (!retrieval) return 'unknown'
  const c = retrieval.context
  if (c.calendarSkippedByDirectIntent) return `direct:${c.matchMode ?? '?'}`
  if (c.calendarSkippedByLocalExactMatch) return 'exact-title'
  if (c.conversationScopedFollowUp && c.scopedToFocusedRecordings) return 'scoped:focused'
  if (c.conversationScopedFollowUp && c.scopedToPreviousCalendarList) return 'scoped:calendar-list'
  if (c.conversationScopedFollowUp) return 'scoped:followup'
  if (c.calendarSkippedByLocalRecordingEvidence) return 'local-recording'
  if (c.plannerSource) return `plan:${c.plannerSource}`
  return 'calendar-fallback'
}

function jsonResponse(value: unknown): Response {
  return { ok: true, json: async () => value } as Response
}

function streamResponse(content: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content } })}\n`))
      controller.close()
    }
  })
  return { ok: true, body: stream } as Response
}

describe('Ask AI routing benchmark (AD-83)', () => {
  let baseDir: string
  let streamHandler: (...args: unknown[]) => Promise<void>
  let waitUntilReady: ReturnType<typeof vi.fn>
  const results: CaseResult[] = []

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-bench-'))
    for (const rec of RECORDINGS) {
      await createRecording(baseDir, rec)
    }

    waitUntilReady = vi.fn().mockResolvedValue(undefined)

    // Stub fetch: echo which recordings were placed into model context.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.endsWith('/api/tags')) return jsonResponse({ models: [] })
        if (u.endsWith('/api/embed')) return jsonResponse({ embeddings: [] })
        if (u.endsWith('/api/chat')) {
          const body = JSON.parse(String(init?.body)) as {
            format?: string
            messages: Array<{ content: string }>
          }
          if (body.format === 'json') return jsonResponse({ message: { content: '{}' } })
          const text = lc(JSON.stringify(body.messages))
          const found = [
            ...new Set(
              RECORDINGS.flatMap((r) => [r.titleToken, r.noteToken].filter((t) => text.includes(t)))
            )
          ]
          return streamResponse(`MODEL_ANSWER scope=[${found.join(', ')}]`)
        }
        return jsonResponse({})
      })
    )

    registerChatIpc(
      baseDir,
      { waitUntilReady, isServerRunning: vi.fn(), getBaseUrl: () => 'http://localhost:11434' },
      { getModel: () => 'fake-model' } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )

    streamHandler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1] as never
  })

  afterAll(async () => {
    await writeScorecard(results)
    await rm(baseDir, { recursive: true, force: true })
  })

  it('runs the routing matrix and produces a scorecard', async () => {
    let senderId = 1000
    for (const scenario of SCENARIOS) {
      senderId += 1
      const sender = { id: senderId, send: vi.fn() }
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...(scenario.seedHistory ?? [])
      ]

      for (let i = 0; i < scenario.turns.length; i++) {
        const turn = scenario.turns[i]
        const requestId = `${scenario.id}-${i}`
        const eventsBefore = capturedEvents.length
        const waitBefore = waitUntilReady.mock.calls.length

        await streamHandler({ sender } as never, requestId, turn.question, history.slice(-8))

        const answer = getDoneContent(sender.send, requestId)
        const turnEvents = capturedEvents.slice(eventsBefore)
        const outcome: TurnOutcome = {
          question: turn.question,
          answer,
          modelInvoked: waitUntilReady.mock.calls.length > waitBefore,
          route: deriveRoute(turnEvents)
        }

        history.push({ role: 'user', content: turn.question })
        history.push({ role: 'assistant', content: answer })

        // Only score "real" assertion turns; seed/list turns use `() => true`.
        const pass = turn.check(outcome)
        results.push({
          scenario: scenario.id,
          category: scenario.category,
          question: turn.question,
          expectation: turn.expectation,
          pass,
          answer,
          route: outcome.route,
          modelInvoked: outcome.modelInvoked
        })
      }
    }

    // The benchmark is a measurement, not a gate: it always "passes" as long as
    // every case produced a result. The scorecard captures the real signal.
    const expectedCases = SCENARIOS.reduce((n, s) => n + s.turns.length, 0)
    expect(results.length).toBe(expectedCases)
    printSummary(results)
  })
})

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-benchmark')
const LATEST_PATH = join(REPORT_DIR, 'latest.json')
const BASELINE_PATH = join(REPORT_DIR, 'baseline.json')
const MARKDOWN_PATH = join(REPORT_DIR, 'scorecard.md')

interface Scorecard {
  generatedAt: string
  total: number
  passed: number
  failed: number
  passRate: number
  byCategory: Record<string, { passed: number; total: number }>
  cases: CaseResult[]
}

function buildScorecard(results: CaseResult[]): Scorecard {
  const scored = results.filter((r) => r.expectation !== 'list')
  const passed = scored.filter((r) => r.pass).length
  const byCategory: Record<string, { passed: number; total: number }> = {}
  for (const r of scored) {
    const bucket = (byCategory[r.category] ??= { passed: 0, total: 0 })
    bucket.total += 1
    if (r.pass) bucket.passed += 1
  }
  return {
    generatedAt: new Date().toISOString(),
    total: scored.length,
    passed,
    failed: scored.length - passed,
    passRate: scored.length === 0 ? 0 : Math.round((passed / scored.length) * 1000) / 10,
    byCategory,
    cases: scored
  }
}

async function writeScorecard(results: CaseResult[]): Promise<void> {
  const scorecard = buildScorecard(results)
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(LATEST_PATH, `${JSON.stringify(scorecard, null, 2)}\n`)
  if (process.env.BENCH_SAVE_BASELINE === '1') {
    await writeFile(BASELINE_PATH, `${JSON.stringify(scorecard, null, 2)}\n`)
  }
  await writeFile(MARKDOWN_PATH, renderMarkdown(scorecard))
}

function renderMarkdown(s: Scorecard): string {
  const lines: string[] = []
  lines.push('# Ask AI routing benchmark scorecard')
  lines.push('')
  lines.push(`- Generated: ${s.generatedAt}`)
  lines.push(`- Pass rate: **${s.passRate}%** (${s.passed}/${s.total})`)
  lines.push('')
  lines.push('## By category')
  lines.push('')
  lines.push('| Category | Pass | Total |')
  lines.push('| --- | --- | --- |')
  for (const [cat, v] of Object.entries(s.byCategory)) {
    lines.push(`| ${cat} | ${v.passed} | ${v.total} |`)
  }
  lines.push('')
  lines.push('## Cases')
  lines.push('')
  lines.push('| ✓ | Scenario | Question | Expectation | Route | Model? | Answer |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const c of s.cases) {
    const ans = c.answer.replace(/\n+/g, ' ').slice(0, 80).replace(/\|/g, '\\|')
    lines.push(
      `| ${c.pass ? '✅' : '❌'} | ${c.scenario} | ${c.question.replace(/\|/g, '\\|')} | ${c.expectation.replace(/\|/g, '\\|')} | ${c.route} | ${c.modelInvoked ? 'yes' : 'no'} | ${ans} |`
    )
  }
  lines.push('')
  return lines.join('\n')
}

function printSummary(results: CaseResult[]): void {
  const s = buildScorecard(results)
  const lines = [
    '',
    '════════ Ask AI routing benchmark ════════',
    `Pass rate: ${s.passRate}%  (${s.passed}/${s.total})`,
    ''
  ]
  for (const c of s.cases) {
    if (!c.pass)
      lines.push(
        `  ❌ [${c.category}] ${c.scenario}: "${c.question}" → route=${c.route} model=${c.modelInvoked}`
      )
  }

  let baselineNote = ''
  if (existsSync(BASELINE_PATH)) {
    try {
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Scorecard
      const delta = s.passed - baseline.passed
      const regressed = baseline.cases
        .filter((b) => b.pass)
        .filter((b) => {
          const cur = s.cases.find((c) => c.scenario === b.scenario && c.question === b.question)
          return cur && !cur.pass
        })
        .map((b) => b.scenario)
      baselineNote = `\nvs baseline: ${delta >= 0 ? '+' : ''}${delta} (${baseline.passed} → ${s.passed})`
      if (regressed.length > 0) baselineNote += `\n  ⚠️ REGRESSIONS: ${regressed.join(', ')}`
    } catch {
      // ignore
    }
  }
  lines.push(baselineNote)
  lines.push('═══════════════════════════════════════════')

  console.log(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Fixture + helpers (mirrors chat-ipc.test.ts)
// ---------------------------------------------------------------------------
async function createRecording(baseDir: string, rec: FixtureRecording): Promise<void> {
  const meetingDir = join(baseDir, rec.id)
  await mkdir(meetingDir, { recursive: true })
  await writeFile(join(meetingDir, 'mic.webm'), '')

  const metadata: MeetingMetadata = {
    sourceName: rec.sourceName,
    startedAt: rec.startedAt,
    stoppedAt: rec.startedAt + 30 * 60_000,
    durationSeconds: 30 * 60
  }
  await writeFile(join(meetingDir, 'metadata.json'), JSON.stringify(metadata))
  await writeFile(
    join(meetingDir, 'segments.json'),
    JSON.stringify(createSegments(rec.notes, rec.noteCategory))
  )
}

function createSegments(
  content: string,
  noteCategory: keyof MeetingSegments = 'information'
): MeetingSegments {
  const segments: MeetingSegments = {
    decisions: [],
    actionItems: [],
    information: [],
    discussion: [],
    statusUpdates: []
  }
  segments[noteCategory] = [
    {
      id: 'note-1',
      meetingId: 'fixture',
      category: noteCategory === 'actionItems' ? 'action_item' : 'information',
      topic: 'General',
      title: 'Fixture note',
      content,
      assignee: noteCategory === 'actionItems' ? 'Casey' : null,
      deadline: noteCategory === 'actionItems' ? 'Friday' : null,
      sourceStartMs: 0,
      sourceEndMs: 10_000
    }
  ]
  return segments
}

function getDoneContent(send: ReturnType<typeof vi.fn>, requestId: string): string {
  const doneCall = send.mock.calls.find(
    ([channel, payload]) => channel === 'chat:done' && payload?.requestId === requestId
  )
  if (doneCall) return doneCall[1].content
  const errorCall = send.mock.calls.find(
    ([channel, payload]) => channel === 'chat:error' && payload?.requestId === requestId
  )
  if (errorCall) return `__ERROR__: ${errorCall[1].error}`
  return '__NO_RESPONSE__'
}
