import { describe, expect, it } from 'vitest'
import { fallbackMeetingOverview, fallbackMeetingOverviewFromNotes } from '../notes-overview-text'

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

describe('fallbackMeetingOverviewFromNotes', () => {
  it('uses grounded bullets instead of section titles', () => {
    expect(
      fallbackMeetingOverviewFromNotes(
        [
          {
            title: 'Relay hosting capacity review',
            keyPoints: [{ text: 'Cut idle replicas after the last canary' }]
          },
          {
            title: 'Offline analytics coverage',
            keyPoints: [{ text: 'Login events now include the consent flag' }]
          }
        ],
        'Weekly sync'
      )
    ).toBe(
      'Cut idle replicas after the last canary. Login events now include the consent flag.'
    )
  })

  it('falls back to titles when bullets are only restated headings', () => {
    expect(
      fallbackMeetingOverviewFromNotes([
        { title: 'Relay hosting', keyPoints: [{ text: 'Relay hosting' }] },
        { title: 'Offline analytics', keyPoints: [{ text: 'Short' }] }
      ])
    ).toBe('This meeting covered Relay hosting, and Offline analytics.')
  })
})
