import { describe, expect, it } from 'vitest'
import {
  classifyChatTurn,
  extractReferencedCount,
  hasFreshSearchTerms,
  isImplicitFollowUp,
  resolveOrdinalIndex,
  resolveTitleReference,
  type ChatTurnSession
} from '../chat-turn-classifier'

const LISTED: ChatTurnSession = {
  recordingIds: ['r-roadmap', 'r-support', 'r-design', 'r-calendar'],
  recordingTitles: ['Roadmap Review', 'Support Triage', 'Design Sync', 'Calendar Auth Review'],
  calendarEventCount: 0,
  focusedRecordingIds: [],
  lastTurnWasClarification: false
}

const PRIOR_LIST_HISTORY = [
  { role: 'user' as const, content: 'list my recordings' },
  { role: 'assistant' as const, content: 'Here are your recordings: ...' }
]

const emptySession = (): ChatTurnSession => ({
  recordingIds: [],
  recordingTitles: [],
  calendarEventCount: 0,
  focusedRecordingIds: [],
  lastTurnWasClarification: false
})

describe('classifyChatTurn — acknowledgements', () => {
  it('treats gratitude as an acknowledgement', () => {
    for (const q of ['thanks!', 'ok cool', 'much appreciated', 'cheers', 'no worries, ty', 'thx']) {
      expect(classifyChatTurn(q, PRIOR_LIST_HISTORY, LISTED).kind, q).toBe('acknowledgement')
    }
  })

  it('treats gratitude with intensifier filler as an acknowledgement', () => {
    for (const q of [
      'got it, thanks a lot',
      'thanks so much',
      'thanks a ton',
      'thank you very much',
      'thanks a bunch'
    ]) {
      expect(classifyChatTurn(q, PRIOR_LIST_HISTORY, LISTED).kind, q).toBe('acknowledgement')
    }
  })

  it('does not treat a bare intensifier/doubt as gratitude', () => {
    for (const q of ['really?', 'so?']) {
      expect(classifyChatTurn(q, PRIOR_LIST_HISTORY, LISTED).kind, q).not.toBe('acknowledgement')
    }
  })

  it('does not swallow a mixed thanks+request as an acknowledgement', () => {
    expect(
      classifyChatTurn('thanks, can you show action items?', PRIOR_LIST_HISTORY, LISTED).kind
    ).not.toBe('acknowledgement')
  })

  it('does not treat a bare affirmation answering a clarification as gratitude', () => {
    const session = { ...emptySession(), lastTurnWasClarification: true }
    const history = [
      { role: 'user' as const, content: 'pull up the roadmap meeting' },
      { role: 'assistant' as const, content: 'Which one should I use? 1. Roadmap 2. Design' }
    ]
    expect(classifyChatTurn('yes', history, session).kind).not.toBe('acknowledgement')
    expect(classifyChatTurn('yep the first one', history, session).kind).not.toBe('acknowledgement')
  })
})

describe('classifyChatTurn — small talk', () => {
  it('routes greetings to small talk without retrieval', () => {
    for (const q of ['hey', 'hi there', 'hello!', 'good morning', 'yo', 'how are you?']) {
      expect(classifyChatTurn(q, [], emptySession()), q).toEqual({
        kind: 'smalltalk',
        topic: 'greeting'
      })
    }
  })

  it('routes capability questions to small talk', () => {
    for (const q of ['what can you do?', 'who are you?', 'what is this?']) {
      expect(classifyChatTurn(q, [], emptySession()), q).toEqual({
        kind: 'smalltalk',
        topic: 'capability'
      })
    }
  })

  it('does not treat a greeting glued to a real request as small talk', () => {
    expect(
      classifyChatTurn('hey what did we discuss in the design sync', [], LISTED).kind
    ).not.toBe('smalltalk')
    expect(classifyChatTurn('hi can you list my recordings', [], emptySession()).kind).not.toBe(
      'smalltalk'
    )
  })
})

describe('classifyChatTurn — count confirmations', () => {
  it('confirms an explicit count from session state', () => {
    const turn = classifyChatTurn('so four then?', PRIOR_LIST_HISTORY, LISTED)
    expect(turn).toEqual({ kind: 'count_confirmation', scope: 'recording', referencedCount: 4 })
  })

  it('handles implicit "is that all" and "only N" forms', () => {
    expect(classifyChatTurn('is that all of them?', PRIOR_LIST_HISTORY, LISTED).kind).toBe(
      'count_confirmation'
    )
    expect(classifyChatTurn('only 4?', PRIOR_LIST_HISTORY, LISTED)).toEqual({
      kind: 'count_confirmation',
      scope: 'recording',
      referencedCount: 4
    })
  })

  it('uses calendar scope when only calendar meetings were presented', () => {
    const session: ChatTurnSession = { ...emptySession(), calendarEventCount: 8 }
    const turn = classifyChatTurn('so 8 then?', PRIOR_LIST_HISTORY, session)
    expect(turn).toEqual({ kind: 'count_confirmation', scope: 'calendar', referencedCount: 8 })
  })

  it('does not treat a real request containing a number as a confirmation', () => {
    expect(classifyChatTurn('show me 2 action items', PRIOR_LIST_HISTORY, LISTED).kind).not.toBe(
      'count_confirmation'
    )
  })
})

describe('classifyChatTurn — coreference', () => {
  it('resolves ordinal words against the presented list', () => {
    expect(
      classifyChatTurn('show notes for the second one', PRIOR_LIST_HISTORY, LISTED)
    ).toMatchObject({ kind: 'reference', meetingIds: ['r-support'] })
    expect(classifyChatTurn('summarize the third one', PRIOR_LIST_HISTORY, LISTED)).toMatchObject({
      kind: 'reference',
      meetingIds: ['r-design']
    })
  })

  it('resolves "the last one" to the final list item', () => {
    expect(
      classifyChatTurn('show notes for the last one', PRIOR_LIST_HISTORY, LISTED)
    ).toMatchObject({ kind: 'reference', meetingIds: ['r-calendar'] })
  })

  it('resolves a title-style reference', () => {
    expect(
      classifyChatTurn('tell me about the calendar auth one', PRIOR_LIST_HISTORY, LISTED)
    ).toMatchObject({ kind: 'reference', meetingIds: ['r-calendar'] })
  })

  it('treats a quantity as a quantity, never as the Nth list slot', () => {
    // "3" is a quantity; the explicit "support meeting" should win, never the 3rd slot.
    const top3 = classifyChatTurn(
      'what are the top 3 action items from the support meeting?',
      PRIOR_LIST_HISTORY,
      LISTED
    )
    if (top3.kind === 'reference') {
      expect(top3.meetingIds).toEqual(['r-support'])
      expect(top3.meetingIds).not.toContain('r-design') // the 3rd slot
    }

    // "2" is a quantity; must never resolve to the 2nd slot (Support).
    const takeaways = classifyChatTurn(
      'give me 2 takeaways from the roadmap review',
      PRIOR_LIST_HISTORY,
      LISTED
    )
    if (takeaways.kind === 'reference') {
      expect(takeaways.meetingIds).not.toContain('r-support')
    }
  })
})

describe('resolveOrdinalIndex', () => {
  it('maps ordinal words and suffixed numerals only with a referential anchor', () => {
    expect(resolveOrdinalIndex('the second one', 4)).toBe(1)
    expect(resolveOrdinalIndex('the 3rd recording', 4)).toBe(2)
    expect(resolveOrdinalIndex('the last one', 4)).toBe(3)
    expect(resolveOrdinalIndex('number 2', 4)).toBe(1)
  })

  it('ignores bare quantities and out-of-range indices', () => {
    expect(resolveOrdinalIndex('3 action items', 4)).toBeNull()
    expect(resolveOrdinalIndex('2 takeaways', 4)).toBeNull()
    expect(resolveOrdinalIndex('the 9th one', 4)).toBeNull()
    expect(resolveOrdinalIndex('second quarter results', 4)).toBeNull()
  })
})

describe('resolveTitleReference', () => {
  it('returns the uniquely best-matching prior title', () => {
    expect(resolveTitleReference('the calendar auth one', 'the calendar auth one', LISTED)).toEqual(
      ['r-calendar']
    )
  })

  it('returns null without a referential anchor', () => {
    expect(resolveTitleReference('calendar auth scopes', 'calendar auth scopes', LISTED)).toBeNull()
  })
})

describe('lexical helpers', () => {
  it('extractReferencedCount reads digits and number words', () => {
    expect(extractReferencedCount('so four then')).toBe(4)
    expect(extractReferencedCount('only 7?')).toBe(7)
    expect(extractReferencedCount('is that all')).toBeNull()
  })

  it('hasFreshSearchTerms ignores generic follow-up vocabulary', () => {
    expect(hasFreshSearchTerms('show action items')).toBe(false)
    expect(hasFreshSearchTerms('what about the billing migration')).toBe(true)
  })

  it('isImplicitFollowUp recognizes short contextual prompts', () => {
    expect(isImplicitFollowUp('anything else?')).toBe(true)
    expect(isImplicitFollowUp('show action items')).toBe(true)
    expect(isImplicitFollowUp('who owns the billing migration checklist')).toBe(false)
  })
})

describe('classifyChatTurn — fresh retrieval', () => {
  it('routes brand-new scope questions to new_retrieval', () => {
    expect(classifyChatTurn('what meetings did I have this week', [], LISTED).kind).toBe(
      'new_retrieval'
    )
    expect(classifyChatTurn('list my recordings', [], emptySession()).kind).toBe('new_retrieval')
  })
})
