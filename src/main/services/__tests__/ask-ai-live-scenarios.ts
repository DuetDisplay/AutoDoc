/**
 * Shared live-eval scenario matrix for the Ask AI head-to-head (v1 vs v2).
 *
 * Both `ask-ai-agent.live.test.ts` (v2 tool-calling agent) and
 * `ask-ai-v1.live.test.ts` (v1 classifier + planner) import this single source
 * of truth so the comparison runs byte-identical questions and predicates
 * against the same fixture recordings. Not a test file itself (no `.test.ts`).
 */
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { MeetingMetadata, MeetingSegments } from '../../../shared/types'

export interface FixtureRecording {
  id: string
  startedAt: number
  sourceName: string
  notes: string
  noteCategory?: keyof MeetingSegments
}

// Ordered most-recent-first when listed: roadmap, support, design, calendar.
export const RECORDINGS: FixtureRecording[] = [
  {
    id: 'live-001-roadmap',
    startedAt: new Date(2026, 5, 1, 10, 0).getTime(),
    sourceName: 'Live Fixture - Roadmap Review',
    notes: 'Roadmap sequencing for Q3 was locked. Priya drives the milestone tracker.'
  },
  {
    id: 'live-002-support',
    startedAt: new Date(2026, 5, 1, 9, 0).getTime(),
    sourceName: 'Live Fixture - Support Triage',
    notes: 'Casey owns the escalation follow-up for the priority customer queue.',
    noteCategory: 'actionItems'
  },
  {
    id: 'live-003-design',
    startedAt: new Date(2026, 5, 1, 8, 0).getTime(),
    sourceName: 'Live Fixture - Design Sync',
    notes: 'The team rewrote the onboarding copy and chose the calmer illustration set.'
  },
  {
    id: 'live-004-calendar',
    startedAt: new Date(2026, 5, 1, 7, 0).getTime(),
    sourceName: 'Live Fixture - Calendar Auth Review',
    notes: 'Google Calendar OAuth scopes need a consent-screen update before launch.'
  }
]

export interface Turn {
  question: string
  check: (answer: string) => boolean
}
export interface Scenario {
  id: string
  category: string
  turns: Turn[]
}

const lc = (s: string): string => s.toLowerCase()
const notWelcome = (a: string): boolean => !/you're welcome|you are welcome/i.test(a)
const has =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.every((t) => lc(a).includes(t))
const lacks =
  (...tokens: string[]) =>
  (a: string): boolean =>
    tokens.every((t) => !lc(a).includes(t))
const all =
  (...checks: Array<(a: string) => boolean>) =>
  (a: string): boolean =>
    checks.every((c) => c(a))

export const SCENARIOS: Scenario[] = [
  {
    id: 'count',
    category: 'inventory',
    turns: [{ question: 'how many recordings do I have?', check: all(has('4'), lacks('0 record')) }]
  },
  {
    id: 'list',
    category: 'inventory',
    turns: [{ question: 'list my recordings', check: has('roadmap') }]
  },
  {
    id: 'ordinal-second',
    category: 'coreference',
    turns: [
      { question: 'list my recordings', check: () => true },
      {
        question: 'show notes for the second one',
        check: all(has('escalation'), lacks('onboarding'))
      }
    ]
  },
  // Skepticism — v2 relies on ONE general "doubt -> re-verify" rule with zero
  // phrase lists. These phrasings are intentionally varied and NOT special-cased,
  // so passing proves generalization rather than memorization.
  {
    id: 'skepticism-you-sure',
    category: 'skepticism',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: 'you sure?', check: all(notWelcome, has('4')) }
    ]
  },
  {
    id: 'skepticism-doesnt-seem-right',
    category: 'skepticism',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: "hmm, that doesn't seem right", check: all(notWelcome, has('4')) }
    ]
  },
  {
    id: 'skepticism-wait-really',
    category: 'skepticism',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: 'wait, really?', check: all(notWelcome, has('4')) }
    ]
  },
  {
    id: 'skepticism-are-you-certain',
    category: 'skepticism',
    turns: [
      { question: 'how many recordings do I have?', check: () => true },
      { question: 'are you certain about that?', check: all(notWelcome, has('4')) }
    ]
  },
  {
    id: 'thanks',
    category: 'acknowledgement',
    turns: [
      { question: 'list my recordings', check: () => true },
      { question: 'thanks!', check: (a) => a.trim().length > 0 && a.length < 200 }
    ]
  },
  {
    id: 'search-owner',
    category: 'search',
    turns: [{ question: 'who owns the escalation follow-up?', check: has('casey') }]
  },
  {
    id: 'quantity-not-ordinal',
    category: 'quantity-vs-ordinal',
    turns: [
      { question: 'list my recordings', check: () => true },
      {
        question: 'give me 2 takeaways from the roadmap review',
        check: all(has('roadmap'), lacks('escalation', 'onboarding'))
      }
    ]
  }
]

export async function createRecording(baseDir: string, rec: FixtureRecording): Promise<void> {
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

export function createSegments(
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
