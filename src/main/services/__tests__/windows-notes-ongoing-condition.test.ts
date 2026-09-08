import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeWriterRecords } from '../notes-writer-grounding'

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
})

const shipmentSource = "Sofia: Then hold today's shipment while the partner lab tells us whether it can accept that excursion. I don't know yet whether any sample is unusable."
function ground(content: string, text = shipmentSource) {
  return sanitizeWriterRecords(
    'information', { title: content, content }, { startMs: 118000, endMs: 118000 },
    [{ startMs: 118000, text }], 'paraphrase'
  )
}

describe('Windows ongoing conditions in polarity verification', () => {
  it('retains an ownerless hold without mistaking the uncertain ending condition for a tentative hold', () => {
    const content = "Hold today's shipment until the partner lab confirms acceptance of the temperature excursion."
    expect(ground(content)).toEqual([expect.objectContaining({ content, salvaged: false })])
  })

  it('retains a definite hold with an unresolved ending condition in another domain', () => {
    const content = 'Keep the door closed until the caretaker confirms the gate is safe.'
    expect(ground(content, 'Keep the door closed while the caretaker checks whether the gate is safe.'))
      .toEqual([expect.objectContaining({ content, salvaged: false })])
  })

  it.each([
    'The partner lab confirmed acceptance of the temperature excursion.',
    'The partner lab has accepted the temperature excursion.',
    "Today's shipment is approved.",
    "Today's shipment will be released.",
    "Hold today's shipment."
  ])('does not infer a resolved condition or remove the stated qualification: %s', content => {
    expect(ground(content).some(record => record.content === content)).toBe(false)
  })

  it('does not turn a tentative hold into a definite one merely because both mention an ending condition', () => {
    const content = 'Keep the door closed until the caretaker confirms the gate is safe.'
    const source = 'We might keep the door closed while the caretaker checks whether the gate is safe.'
    expect(ground(content, source).some(record => record.content === content)).toBe(false)
  })

  it('does not detach a prerequisite from an ordinary release commitment', () => {
    const content = 'We will ship the build.'
    expect(ground(content, 'We will ship the build if QA passes.').some(record => record.content === content))
      .toBe(false)
  })
})
