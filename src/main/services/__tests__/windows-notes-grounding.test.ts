import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeWriterRecords, type WriterGroundingCategory } from '../notes-writer-grounding'

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
})

function ground(category: WriterGroundingCategory, content: string, text: string) {
  return sanitizeWriterRecords(category, { title: content, content }, { startMs: 1000, endMs: 1000 }, [{ startMs: 1000, text }], 'paraphrase')
}

describe('Windows clause-scoped grounding', () => {
  it('recognizes names beginning with a non-ASCII letter', () => {
    const content = 'Élodie will verify the ramp by Friday.'
    expect(ground('action_items', content, 'Élodie will check the ramp by Friday.').some((row) => row.content === content)).toBe(true)
  })
  it('rejects a bundled unsupported cause without trimming its explanation into customer prose', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'catalog')
    const content = 'Local models have limited formatting capacity due to frontier model assumptions.'
    const result = ground('information', content, 'Atlas uses a frontier model. Local models have limited formatting capacity.')
    expect(result.some((row) => row.content.includes('frontier'))).toBe(false)
    expect(result).toEqual([])
  })
  it('retains an explicitly stated causal relation', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'catalog')
    const content = 'Delivery was delayed because the bridge closed.'
    expect(ground('information', content, content).some((row) => row.content === content)).toBe(true)
  })
  it('does not invent the subject of a drafted message', () => {
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'catalog')
    const content = 'An email draft was created to clarify the equipment requirements.'
    const result = ground('information', content, 'An email draft was created. Please review the draft.')
    expect(result.some((row) => row.content.includes('equipment'))).toBe(false)
    expect(result.some((row) => row.content === 'An email draft was created')).toBe(true)
  })
  it.each([
    ['information', 'The equipment budget remains at $350 and no increase is approved.', 'No, keep the equipment budget at 350 dollars. We are not approving an increase.'],
    ['action_items', 'Renée will verify the ramp and lift by Friday.', 'Renée will check the ramp and the lift by Friday, then report whether they are available.'],
    ['action_items', 'Sam will draft the survey by Monday, focusing on the last time a participant used the service.', 'Sam will draft the survey by Monday. The survey should ask about the last time a participant used the service.'],
    ['discussion', 'Streaming is not approved and remains undecided without a volunteer.', 'Streaming is not approved. Leave streaming undecided until we find a volunteer.'],
    ['decisions', 'The pricing decision is postponed until the interviews finish.', 'Agreed. We are postponing the pricing decision until the interviews finish. No new price has been selected.'],
    ['decisions', 'The pricing decision is postponed until after interviews conclude, with no new price selected.', 'Agreed. We are postponing the pricing decision until the interviews finish. No new price has been selected.'],
    ['information', 'There are 63 registrations with a target of 150.', 'We have 63 current registrations. Our target is 150.'],
    ['decisions', 'The workshop is moving from the courtyard to the library room on Saturday at 10 AM.', "Yes, we have decided to move Saturday's workshop from the courtyard to the library. Keep the start at ten AM. We are changing the room, not the time."],
    ['action_items', "Nora will recruit the remaining participants by Friday to confirm next week's appointments.", "Nora, please recruit the remaining participants by Friday so we can confirm next week's appointments."],
    ['information', 'The team will use release 7.2 for a week unless a significant issue appears.', 'We will use release 7.2 for a week unless a significant issue appears.']
  ] as const)('retains a supported %s: %s', (category, content, evidence) => {
    expect(ground(category, content, evidence).some((row) => row.content === content)).toBe(true)
  })

  it.each([
    ['decisions', 'The equipment budget increase is approved.', 'No, keep the equipment budget at 350 dollars. We are not approving an increase.'],
    ['action_items', 'Renée will check the ramp by Friday.', 'Perhaps Renée will check the ramp by Friday, if she has time.'],
    ['information', 'The ramp and lift are available.', 'Renée will check the ramp and the lift by Friday, then report whether they are available.'],
    ['information', 'The team will use release 7.2 for a week.', 'We will use release 7.2 for a week unless a significant issue appears.'],
    ['decisions', 'We agreed to use release 7.2 for a week.', 'We agreed to use release 7.2 for a week unless a significant issue appears.'],
    ['information', 'The pilot failure rate was 30% and the prototype failure rate was 20%.', 'The prototype failure rate was 30% and the pilot failure rate was 20%.']
  ] as const)('does not retain an unsupported %s: %s', (category, content, evidence) => {
    expect(ground(category, content, evidence).some((row) => row.content === content)).toBe(false)
  })
})
