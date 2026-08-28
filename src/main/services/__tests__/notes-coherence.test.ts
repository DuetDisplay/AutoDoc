import { describe, expect, it } from 'vitest'
import { noteTextLooksCoherent } from '../notes-coherence'

describe('note text coherence', () => {
  it.each([
    'Measured on Mac',
    'I flagging',
    'Me and them are exchanging emails',
    'the the rollout is ready',
    'It is working now',
    'The release is waiting for',
    'Share the debug endpoints that Okay.'
  ])('rejects transcript-shaped fragments: %s', (text) => {
    expect(noteTextLooksCoherent(text)).toBe(false)
  })

  it.each([
    'Trial starts increased by 12% on Mac.',
    'Android RC passed QA.',
    'Connect equals Pro.',
    'Released on Friday.',
    'Review the deployment report.',
    'The customer cannot reconnect in the background.'
  ])('keeps concise standalone notes: %s', (text) => {
    expect(noteTextLooksCoherent(text)).toBe(true)
  })
})
