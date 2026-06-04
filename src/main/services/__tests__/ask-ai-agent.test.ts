/**
 * Ask AI agent (v2) tests.
 *
 * Two layers:
 *   1. Tool-executor grounding — runs the real tools over on-disk fixture
 *      recordings and asserts facts come from disk (counts, ordering, ordinal
 *      coreference). This is the property that makes the AD-83 "0 recordings"
 *      and "wrong meeting" bugs structurally impossible.
 *   2. Loop integration — drives `runAskAiAgent` with a *scripted* tool-calling
 *      model (the `fetch` stub plays the role a real local model would). This is
 *      deliberately not a model-quality benchmark; it proves the loop executes
 *      tools, feeds results back, grounds the final answer, and honors cancel.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MeetingMetadata, MeetingSegments } from '../../../shared/types'
import { ChatRecordingIndex } from '../chat-retrieval'
import {
  executeAgentTool,
  extractTextToolCalls,
  runAskAiAgent,
  type AgentSession,
  type AgentToolDeps
} from '../ask-ai-agent'

interface FixtureRecording {
  id: string
  startedAt: number
  sourceName: string
  notes: string
  noteCategory?: keyof MeetingSegments
}

const RECORDINGS: FixtureRecording[] = [
  {
    id: 'agent-001-roadmap',
    startedAt: new Date(2026, 5, 1, 10, 0).getTime(),
    sourceName: 'Agent Fixture - Roadmap Review',
    notes: 'Roadmap sequencing for Q3 was locked. Priya drives the milestone tracker.'
  },
  {
    id: 'agent-002-support',
    startedAt: new Date(2026, 5, 1, 9, 0).getTime(),
    sourceName: 'Agent Fixture - Support Triage',
    notes: 'Casey owns the escalation follow-up for the priority customer queue.',
    noteCategory: 'actionItems'
  },
  {
    id: 'agent-003-design',
    startedAt: new Date(2026, 5, 1, 8, 0).getTime(),
    sourceName: 'Agent Fixture - Design Sync',
    notes: 'The team rewrote the onboarding copy and chose the calmer illustration set.'
  }
]

function newSession(): AgentSession {
  return {
    lastRecordingIds: [],
    lastRecordingTitles: [],
    lastCalendarEvents: [],
    focusedRecordingIds: []
  }
}

function makeDeps(index: ChatRecordingIndex): AgentToolDeps {
  return {
    recordingIndex: index,
    loadCalendar: async () => ({ recentEvents: [], upcomingEvents: [] }),
    rememberRecordingList: (session, ids, titles) => {
      session.lastRecordingIds = ids
      session.lastRecordingTitles = ids.map((_, i) => titles[i] ?? '')
    }
  }
}

describe('Ask AI agent (v2)', () => {
  let baseDir: string
  let index: ChatRecordingIndex

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'autodoc-agent-test-'))
    for (const rec of RECORDINGS) await createRecording(baseDir, rec)
    index = new ChatRecordingIndex(baseDir, { watch: false })
  })

  afterAll(async () => {
    index.dispose()
    await rm(baseDir, { recursive: true, force: true })
  })

  describe('tool executor (grounding)', () => {
    it('get_recording_count returns the real on-disk count, never a guess', async () => {
      const { result, summary } = await executeAgentTool(
        'get_recording_count',
        {},
        makeDeps(index),
        newSession()
      )
      expect(result).toMatchObject({ count: RECORDINGS.length, total: RECORDINGS.length })
      expect(summary).toContain(`count=${RECORDINGS.length}`)
    })

    it('list_recordings returns an ordered list and records it on the session', async () => {
      const session = newSession()
      const { result } = (await executeAgentTool(
        'list_recordings',
        {},
        makeDeps(index),
        session
      )) as { result: { recordings: Array<{ position: number; id: string; title: string }> } }

      expect(result.recordings).toHaveLength(RECORDINGS.length)
      expect(result.recordings[0].position).toBe(1)
      // Most-recent-first: roadmap (10:00) precedes support (9:00) precedes design (8:00).
      expect(result.recordings.map((r) => r.id)).toEqual([
        'agent-001-roadmap',
        'agent-002-support',
        'agent-003-design'
      ])
      // Session now holds the ordered list so ordinal references resolve.
      expect(session.lastRecordingIds).toEqual([
        'agent-001-roadmap',
        'agent-002-support',
        'agent-003-design'
      ])
    })

    it('get_meeting_notes resolves an ordinal against the last listed set', async () => {
      const session = newSession()
      await executeAgentTool('list_recordings', {}, makeDeps(index), session)

      const { result } = (await executeAgentTool(
        'get_meeting_notes',
        { ordinal: 2, focus: 'summary' },
        makeDeps(index),
        session
      )) as { result: { meetingId: string; notes: string } }

      expect(result.meetingId).toBe('agent-002-support')
      expect(result.notes.toLowerCase()).toContain('escalation')
      expect(result.notes.toLowerCase()).not.toContain('onboarding')
    })

    it('get_meeting_notes resolves a title_query when there is no list yet', async () => {
      const { result } = (await executeAgentTool(
        'get_meeting_notes',
        { title_query: 'design', focus: 'summary' },
        makeDeps(index),
        newSession()
      )) as { result: { meetingId: string; notes: string } }
      expect(result.meetingId).toBe('agent-003-design')
      expect(result.notes.toLowerCase()).toContain('onboarding')
    })

    it('search_recordings surfaces the matching meeting content', async () => {
      const { result } = (await executeAgentTool(
        'search_recordings',
        { query: 'escalation follow-up owner' },
        makeDeps(index),
        newSession()
      )) as { result: { matchedCount: number; content: string } }
      expect(result.matchedCount).toBeGreaterThan(0)
      expect(result.content.toLowerCase()).toContain('escalation')
    })
  })

  describe('extractTextToolCalls (protocol parser)', () => {
    it('extracts a known tool call from surrounding prose and normalizes parameters', () => {
      const calls = extractTextToolCalls(
        'Sure — {"name": "get_meeting_notes", "parameters": {"ordinal": 2}} done.'
      )
      expect(calls).toHaveLength(1)
      expect(calls[0].function.name).toBe('get_meeting_notes')
      expect(calls[0].function.arguments).toEqual({ ordinal: 2 })
    })

    it('ignores plain prose and unknown tool names', () => {
      expect(extractTextToolCalls('You have 4 recordings.')).toHaveLength(0)
      expect(extractTextToolCalls('{"name": "delete_everything", "parameters": {}}')).toHaveLength(
        0
      )
    })
  })

  describe('agent loop (scripted tool-calling model)', () => {
    it('grounds a count answer in the tool result (cannot fabricate 0)', async () => {
      const fetchMock = scriptedModel()
      vi.stubGlobal('fetch', fetchMock)

      const session = newSession()
      const chunks: string[] = []
      const result = await runAskAiAgent({
        baseUrl: 'http://localhost:11434',
        model: 'fake',
        question: 'how many recordings do I have?',
        history: [],
        session,
        deps: makeDeps(index),
        onChunk: (c) => chunks.push(c)
      })

      expect(result.toolCalls.map((t) => t.name)).toContain('get_recording_count')
      expect(result.answer).toContain(String(RECORDINGS.length))
      expect(chunks.join('')).toContain(String(RECORDINGS.length))
      vi.unstubAllGlobals()
    })

    it('answers a greeting directly without calling a tool', async () => {
      vi.stubGlobal('fetch', scriptedModel())
      const result = await runAskAiAgent({
        baseUrl: 'http://localhost:11434',
        model: 'fake',
        question: 'hey',
        history: [],
        session: newSession(),
        deps: makeDeps(index),
        onChunk: () => {}
      })
      expect(result.toolCalls).toHaveLength(0)
      expect(result.steps).toBe(1)
      expect(result.answer.toLowerCase()).toContain('hi')
      vi.unstubAllGlobals()
    })

    it('recovers a tool call the model emits as plain text (protocol robustness)', async () => {
      // Scripted model that does NOT use structured tool_calls — it dumps the
      // call into content, like llama3.1:8b sometimes does. The agent should
      // still execute it and ground the answer instead of showing JSON.
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string; tool_name?: string }>
        }
        const countToolMsg = body.messages.find(
          (m) => m.role === 'tool' && m.tool_name === 'get_recording_count'
        )
        const message = countToolMsg
          ? {
              content: `You have ${(JSON.parse(countToolMsg.content) as { count: number }).count} recordings.`
            }
          : {
              content: 'Let me check. {"name": "get_recording_count", "parameters": {}} one moment.'
            }
        return { ok: true, json: async () => ({ message }) } as Response
      })
      vi.stubGlobal('fetch', fetchMock)

      const result = await runAskAiAgent({
        baseUrl: 'http://localhost:11434',
        model: 'fake',
        question: 'how many recordings do I have?',
        history: [],
        session: newSession(),
        deps: makeDeps(index),
        onChunk: () => {}
      })
      expect(result.toolCalls.map((t) => t.name)).toContain('get_recording_count')
      expect(result.answer).toContain(String(RECORDINGS.length))
      vi.unstubAllGlobals()
    })

    it('throws an AbortError when the signal is aborted before a round', async () => {
      vi.stubGlobal('fetch', scriptedModel())
      const controller = new AbortController()
      controller.abort()
      await expect(
        runAskAiAgent({
          baseUrl: 'http://localhost:11434',
          model: 'fake',
          question: 'how many recordings do I have?',
          history: [],
          session: newSession(),
          deps: makeDeps(index),
          signal: controller.signal,
          onChunk: () => {}
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      vi.unstubAllGlobals()
    })
  })
})

/**
 * A deterministic stand-in for a tool-calling Ollama model. It inspects the
 * conversation and decides: if the user asked for a count and the count tool has
 * not run yet, request it; once the tool result is present, answer with that
 * exact number; greetings are answered directly with no tool.
 */
function scriptedModel(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string; tool_name?: string }>
    }
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
    const countToolMsg = body.messages.find(
      (m) => m.role === 'tool' && m.tool_name === 'get_recording_count'
    )

    const asksCount = /how many|count/i.test(lastUser?.content ?? '')
    const isGreeting = /^\s*(hey|hi|hello)\b/i.test(lastUser?.content ?? '')

    let message: { content: string; tool_calls?: unknown[] }
    if (isGreeting) {
      message = { content: 'Hi! Ask me anything about your meetings.' }
    } else if (asksCount && !countToolMsg) {
      message = {
        content: '',
        tool_calls: [{ function: { name: 'get_recording_count', arguments: {} } }]
      }
    } else if (countToolMsg) {
      const parsed = JSON.parse(countToolMsg.content) as { count: number }
      message = { content: `You have ${parsed.count} recordings.` }
    } else {
      message = { content: 'I am not sure how to help with that.' }
    }

    return { ok: true, json: async () => ({ message }) } as Response
  })
}

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
