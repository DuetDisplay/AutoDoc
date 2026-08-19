import { describe, expect, it } from 'vitest'
import { fallbackMeetingOverview } from '../notes-overview-text'

describe('fallbackMeetingOverview', () => {
  it('joins two or more section titles', () => {
    expect(fallbackMeetingOverview(['Windows Tickets', 'Next Steps'])).toBe(
      'This meeting covered Windows Tickets, and Next Steps.'
    )
  })

  it('uses a single section or meeting title when needed', () => {
    expect(fallbackMeetingOverview(['Analytics'])).toBe('This meeting focused on Analytics.')
    expect(fallbackMeetingOverview([], 'Eng Sync')).toBe('Notes from Eng Sync.')
    expect(fallbackMeetingOverview([])).toBe('')
  })
})
