import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/autodoc-router-test') },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn()
}))

import { decideAskAiRoute, looksLikeConversationalDoubt } from '../chat-ipc'

type Session = Parameters<typeof decideAskAiRoute>[2]

function session(overrides: Partial<Session> = {}): Session {
  return {
    lastCalendarEvents: [],
    lastRecordingIds: [],
    lastRecordingTitles: [],
    focusedRecordingIds: [],
    lastClarificationOptions: [],
    ...overrides
  }
}

const listed = session({
  lastRecordingIds: ['r-roadmap', 'r-support', 'r-design', 'r-calendar'],
  lastRecordingTitles: ['Roadmap Review', 'Support Triage', 'Design Sync', 'Calendar Auth']
})
const priorList = [
  { role: 'user' as const, content: 'list my recordings' },
  { role: 'assistant' as const, content: 'Here are your 4 recordings...' }
]
const priorCount = [
  { role: 'user' as const, content: 'how many recordings do I have?' },
  { role: 'assistant' as const, content: 'You have 4 recordings.' }
]

describe('looksLikeConversationalDoubt', () => {
  it('matches skeptical pushback', () => {
    for (const phrase of [
      'you sure?',
      'are you sure about that?',
      'wait, really?',
      'are you certain?',
      "that's not right",
      "that doesn't seem right",
      'seriously?'
    ]) {
      expect(looksLikeConversationalDoubt(phrase)).toBe(true)
    }
  })

  it('does not match genuine gratitude or affirmations', () => {
    for (const phrase of [
      'thanks',
      'thank you',
      'sounds good',
      'ok cool',
      'got it',
      'perfect',
      'nice'
    ]) {
      expect(looksLikeConversationalDoubt(phrase)).toBe(false)
    }
  })
})

describe('decideAskAiRoute (hybrid)', () => {
  it('keeps inventory count/list on the instant v1 path', () => {
    expect(decideAskAiRoute('how many recordings do I have?', [], session())).toBe('v1')
    expect(decideAskAiRoute('list my recordings', [], session())).toBe('v1')
  })

  it('keeps deterministic coreference and confirmations on v1', () => {
    expect(decideAskAiRoute('show notes for the second one', priorList, listed)).toBe('v1')
    expect(decideAskAiRoute('is that all?', priorCount, listed)).toBe('v1')
  })

  it('keeps smalltalk on v1', () => {
    expect(decideAskAiRoute('good morning!', [], session())).toBe('v1')
    expect(decideAskAiRoute('what can you do?', [], session())).toBe('v1')
  })

  it('routes a bare doubt acknowledgement ("you sure?") to the agent, gratitude to v1', () => {
    // "you sure?" is the case v1 structurally misfires on (-> "You're welcome.").
    // It is the one the turn classifier labels an acknowledgement, so it is the
    // one the hybrid hands to the agent to re-verify.
    expect(decideAskAiRoute('you sure?', priorCount, listed)).toBe('agent')
    expect(decideAskAiRoute('thanks!', priorList, listed)).toBe('v1')
    expect(decideAskAiRoute('thank you so much', priorList, listed)).toBe('v1')
  })

  it('keeps open-ended Q&A on v1 (its RAG grounds better than the local toolcaller)', () => {
    expect(decideAskAiRoute('who owns the escalation follow-up?', [], session())).toBe('v1')
    expect(decideAskAiRoute('summarize the design sync', [], session())).toBe('v1')
    expect(decideAskAiRoute('what did we decide about pricing?', [], session())).toBe('v1')
  })
})
