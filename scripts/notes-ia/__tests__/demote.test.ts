import { describe, expect, it } from 'vitest'

import { shouldDemote } from '../demote.ts'
import { item } from './fixtures.ts'

describe('decision and action demotion', () => {
  it('demotes questions, hedges, and future-conditionals', () => {
    const demoteCases = [
      item({
        id: 'q',
        bucket: 'decisions',
        content: 'Should we move the Orion soak test to next week?',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'maybe',
        bucket: 'decisions',
        content: 'Maybe we ship the beta firmware on Friday.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'what-if',
        bucket: 'actionItems',
        content: 'What if we delay the antenna calibration?',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'could',
        bucket: 'decisions',
        content: 'We could try a new vendor for the clock boards.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'propose',
        bucket: 'decisions',
        content: 'I propose we change the default polling interval.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'consider',
        bucket: 'actionItems',
        content: 'Consider adding a timeout around the handshake.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'we-may',
        bucket: 'decisions',
        content: 'We may need another engineer on the protocol.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'thinking',
        bucket: 'decisions',
        content: 'Thinking about rewriting the parser before freeze.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'might',
        bucket: 'actionItems',
        content: 'It might be worth postponing the field trial.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'if-we',
        bucket: 'decisions',
        content: 'If we had more time we would rewrite the handshake.',
        startMs: 0,
        endMs: 1000
      })
    ]

    for (const example of demoteCases) {
      expect(shouldDemote(example), example.id).toBe(true)
    }
  })

  it('does not demote genuine commitments', () => {
    const keepCases = [
      item({
        id: 'i-will',
        bucket: 'actionItems',
        content: 'I will send the Orion firmware bundle by Friday.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'agreed',
        bucket: 'decisions',
        content: 'We agreed to ship the clock protocol on Thursday.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'alex-will',
        bucket: 'actionItems',
        content: 'Alex will send the calibration sheet tomorrow.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'decided',
        bucket: 'decisions',
        content: 'We decided to keep the current polling interval.',
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'ill',
        bucket: 'actionItems',
        content: "I'll share the soak-test log after the call.",
        startMs: 0,
        endMs: 1000
      }),
      item({
        id: 'information-question',
        bucket: 'information',
        content: 'Did the soak test finish overnight?',
        startMs: 0,
        endMs: 1000
      })
    ]

    for (const example of keepCases) {
      expect(shouldDemote(example), example.id).toBe(false)
    }
  })
})
