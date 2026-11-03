/**
 * Live A/B for Ask AI: real qwen3:4b-instruct answers, first-token + done latency,
 * and grounded-accuracy checks. Gated by AUTODOC_LIVE_EVAL=1.
 *
 *   AUTODOC_LIVE_EVAL=1 AUTODOC_OLLAMA_URL=http://127.0.0.1:11435 \
 *   AUTODOC_ASK_AI_MODEL=qwen3:4b-instruct AUTODOC_ASK_AI_AB_LABEL=post \
 *   npm run test:main:run -- src/main/ipc/__tests__/ask-ai-live-ab.live.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const LIVE = process.env.AUTODOC_LIVE_EVAL === '1'
const BASE_URL = process.env.AUTODOC_OLLAMA_URL ?? 'http://127.0.0.1:11435'
const MODEL = process.env.AUTODOC_ASK_AI_MODEL ?? 'qwen3:4b-instruct'
const LABEL = process.env.AUTODOC_ASK_AI_AB_LABEL ?? 'post'
const REPORT_DIR = join(process.cwd(), 'artifacts', 'ask-ai-live-ab')

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => join(tmpdir(), 'autodoc-ask-ai-ab-userdata')) },
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

interface TurnResult {
  id: string
  question: string
  pass: boolean
  firstTokenMs: number | null
  doneMs: number
  sourceCardMs: number | null
  sourceCount: number
  answer: string
}

const lc = (s: string): string => s.toLowerCase()
const hasAny =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.some((t) => lc(a).includes(t))
const lacks =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.every((t) => !lc(a).includes(t))
const expressesAbsence = (a: string): boolean =>
  /\b(no|not|don'?t|doesn'?t|didn'?t|can'?t|cannot|nothing|none|unable|n'?t (find|see|have))\b/i.test(
    a
  )

const CASES: Array<{
  id: string
  question: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  expectFastPath?: boolean
  check: (answer: string) => boolean
}> = [
  {
    id: 'inventory-count',
    question: 'how many recordings do I have?',
    expectFastPath: true,
    check: (a) => /\b3\b/.test(a) && !/0 recording/i.test(a)
  },
  {
    id: 'billing-decision',
    question: 'What did we decide about the invoice export?',
    expectFastPath: true,
    check: (a) => hasAny('invoice', 'export', 'priya')(a) && lacks('jordan', 'mars')(a)
  },
  {
    id: 'billing-owner',
    question: 'Who owns the billing follow-up?',
    check: hasAny('priya')
  },
  {
    id: 'design-onboarding',
    question: 'What did the design sync decide about onboarding?',
    check: hasAny('onboarding', 'illustration', 'calmer', 'copy')
  },
  {
    id: 'follow-up-due',
    question: 'when is that due?',
    history: [
      { role: 'user', content: 'Who owns the billing follow-up?' },
      { role: 'assistant', content: 'Priya owns the billing follow-up.' }
    ],
    check: hasAny('friday', 'due', 'priya')
  },
  {
    id: 'fabrication',
    question: 'What did Jordan say our Q3 revenue target is?',
    check: (a) => expressesAbsence(a) && lacks('$', 'million', 'billion')(a)
  }
]

describe.skipIf(!LIVE)(`Ask AI live A/B (${LABEL})`, () => {
  let baseDir: string
  const results: TurnResult[] = []

  beforeAll(async () => {
    const reachable = await fetch(`${BASE_URL}/api/tags`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!reachable) throw new Error(`Ollama not reachable at ${BASE_URL}`)
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-ask-ai-ab-'))
    await seedV2Library(baseDir)
  }, 60_000)

  afterAll(async () => {
    if (results.length === 0) return
    await mkdir(REPORT_DIR, { recursive: true })
    const modelTurns = results.filter((r) => !CASES.find((c) => c.id === r.id)?.expectFastPath)
    const lat = modelTurns.map((r) => r.doneMs).sort((a, b) => a - b)
    const first = modelTurns.map((r) => r.firstTokenMs ?? r.doneMs).sort((a, b) => a - b)
    const summary = {
      label: LABEL,
      model: MODEL,
      generatedAt: new Date().toString(),
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      modelTurns: modelTurns.length,
      modelPass: modelTurns.filter((r) => r.pass).length,
      doneMs: { p50: lat[Math.floor(lat.length / 2)] ?? 0, max: lat[lat.length - 1] ?? 0 },
      firstTokenMs: {
        p50: first[Math.floor(first.length / 2)] ?? 0,
        max: first[first.length - 1] ?? 0
      },
      cases: results
    }
    await writeFile(join(REPORT_DIR, `${LABEL}.json`), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(
      `\n════════ Ask AI live A/B ${LABEL} ════════\n` +
        `pass ${summary.passed}/${summary.total}  model ${summary.modelPass}/${summary.modelTurns}\n` +
        `first-token p50=${summary.firstTokenMs.p50}ms  done p50=${summary.doneMs.p50}ms max=${summary.doneMs.max}ms\n` +
        results
          .map(
            (r) =>
              `  ${r.pass ? '✅' : '❌'} ${r.id} first=${r.firstTokenMs ?? '-'}ms done=${r.doneMs}ms sources=${r.sourceCount} → ${r.answer.slice(0, 90).replace(/\n/g, ' ')}`
          )
          .join('\n')
    )
    if (baseDir) await rm(baseDir, { recursive: true, force: true })
  })

  it('asks grounded V2 questions against a real local model', async () => {
    const { ipcMain } = await import('electron')
    const { registerChatIpc } = await import('../chat-ipc')
    registerChatIpc(
      baseDir,
      {
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        isServerRunning: vi.fn().mockResolvedValue(true),
        getBaseUrl: () => BASE_URL,
        getAskAiModel: () => MODEL
      } as never,
      { getModel: () => MODEL } as never,
      {
        fetchAllRecentEvents: vi.fn().mockResolvedValue([]),
        fetchAllUpcomingEvents: vi.fn().mockResolvedValue([])
      } as never
    )
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'chat:send-stream')?.[1] as StreamHandler | undefined
    if (!handler) throw new Error('chat:send-stream was not registered')

    let senderId = 4000
    for (const testCase of CASES) {
      senderId += 1
      const events: Array<{ channel: string; at: number; payload: Record<string, unknown> }> = []
      const sender = {
        id: senderId,
        send: vi.fn((channel: string, payload: Record<string, unknown>) => {
          events.push({ channel, at: Date.now(), payload })
        })
      }
      const requestId = `${LABEL}-${testCase.id}`
      const startedAt = Date.now()
      await handler({ sender }, requestId, testCase.question, testCase.history ?? [])
      const doneMs = Date.now() - startedAt
      const firstChunk = events.find((event) => event.channel === 'chat:chunk')
      const sources = events.find((event) => event.channel === 'chat:sources')
      const done = events.find((event) => event.channel === 'chat:done')
      const error = events.find((event) => event.channel === 'chat:error')
      const answer = error
        ? `__ERROR__: ${String(error.payload.error)}`
        : String(done?.payload.content ?? '__NO_RESPONSE__')

      results.push({
        id: testCase.id,
        question: testCase.question,
        pass: testCase.check(answer),
        firstTokenMs: firstChunk ? firstChunk.at - startedAt : null,
        doneMs,
        sourceCardMs: sources ? sources.at - startedAt : null,
        sourceCount: Array.isArray(sources?.payload.sources) ? sources.payload.sources.length : 0,
        answer
      })
    }

    expect(results).toHaveLength(CASES.length)
  }, 900_000)
})

async function seedV2Library(baseDir: string): Promise<void> {
  const meetings = [
    {
      id: 'ab-billing',
      sourceName: 'Billing Sync',
      startedAt: new Date(2026, 4, 27, 10).getTime(),
      notes: {
        schemaVersion: 2,
        overview: {
          text: 'The team aligned on billing migration and the invoice export.',
          sources: [{ startMs: 1200, endMs: 4000 }]
        },
        keyTakeaways: [
          {
            id: 't1',
            text: 'Ship the invoice export this week. Priya owns the billing follow-up.',
            sources: [{ startMs: 84000, endMs: 90000 }]
          }
        ],
        sections: [],
        decisions: [
          {
            id: 'd1',
            text: 'Use the new invoice export pipeline instead of the legacy CSV importer.',
            sources: [{ startMs: 60000, endMs: 70000 }]
          }
        ],
        nextSteps: [
          {
            id: 'n1',
            text: 'Priya will review the billing PR',
            owner: 'Priya',
            deadline: 'Friday',
            sources: [{ startMs: 120000, endMs: 125000 }]
          }
        ]
      }
    },
    {
      id: 'ab-design',
      sourceName: 'Design Sync',
      startedAt: new Date(2026, 4, 26, 15).getTime(),
      notes: {
        schemaVersion: 2,
        overview: {
          text: 'The team rewrote the onboarding copy and chose the calmer illustration set.',
          sources: [{ startMs: 2000, endMs: 5000 }]
        },
        keyTakeaways: [
          {
            id: 't1',
            text: 'Onboarding should feel calmer and drop the busy hero illustration.',
            sources: [{ startMs: 15000, endMs: 20000 }]
          }
        ],
        sections: [],
        decisions: [],
        nextSteps: []
      }
    },
    {
      id: 'ab-support',
      sourceName: 'Support Triage',
      startedAt: new Date(2026, 4, 25, 9).getTime(),
      notes: {
        schemaVersion: 2,
        overview: { text: 'Casey owns the escalation follow-up for the priority customer queue.' },
        keyTakeaways: [],
        sections: [],
        decisions: [],
        nextSteps: [
          {
            id: 'n1',
            text: 'Casey will close the priority escalation',
            owner: 'Casey',
            deadline: 'Thursday'
          }
        ]
      }
    }
  ]

  for (const meeting of meetings) {
    const dir = join(baseDir, meeting.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mic.webm'), '')
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({
        sourceName: meeting.sourceName,
        startedAt: meeting.startedAt,
        stoppedAt: meeting.startedAt + 30 * 60_000,
        durationSeconds: 30 * 60
      })
    )
    await writeFile(join(dir, 'notes.json'), JSON.stringify(meeting.notes))
  }
}
