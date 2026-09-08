import { describe, expect, it } from 'vitest'
import {
  noteRecordNeedsReview,
  noteSubjectIsResolved,
  noteTextLooksCoherent,
  noteTextLooksCorrupted
} from '../notes-coherence'

describe('note text coherence', () => {
  it.each([
    'Measured on Mac',
    'I flagging',
    'Me and them are exchanging emails',
    'the the rollout is ready',
    'It is working now',
    'The release is waiting for',
    'Share the debug endpoints that Okay.',
    "Give you an update as to As to when that'll be ready",
    'Get the back to the And second thing about the feature flag'
  ])('rejects transcript-shaped fragments: %s', (text) => {
    expect(noteTextLooksCoherent(text)).toBe(false)
  })

  it.each([
    'Trial starts increased by 12% on Mac.',
    'Android RC passed QA.',
    'Connect equals Pro.',
    'Released on Friday.',
    'Review the deployment report.',
    'The customer cannot reconnect in the background.',
    'Compare the A build and the B build side by side.'
  ])('keeps concise standalone notes: %s', (text) => {
    expect(noteTextLooksCoherent(text)).toBe(true)
  })

  it('flags encoding corruption and empty tasks for review', () => {
    expect(noteTextLooksCorrupted('KeŰ runningŰ This Annual default test')).toBe(true)
    expect(noteRecordNeedsReview('Ask you a question')).toBe(true)
    expect(noteRecordNeedsReview('Give some feedback')).toBe(true)
    expect(
      noteRecordNeedsReview('Um Get the nines repositioned uh like we have them uh in the current website.')
    ).toBe(true)
    expect(noteRecordNeedsReview('Trial starts increased by 12% on Mac.')).toBe(false)
  })

  it('requires a resolvable subject before promoting a comparison', () => {
    expect(
      noteSubjectIsResolved('The spread and leaders are still the same as yesterday.')
    ).toBe(false)
    expect(
      noteSubjectIsResolved(
        'The spread and leaders are still the same as yesterday.',
        'Trial spread',
        'Data and metrics'
      )
    ).toBe(true)
  })
})
