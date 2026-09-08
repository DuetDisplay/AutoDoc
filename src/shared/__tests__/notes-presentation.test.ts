import { describe, expect, it } from 'vitest'
import {
  normalizeCustomerOverview,
  toCustomerFacingNotes,
  distinctNoteTitle
} from '../notes-presentation'

describe('customer-facing notes', () => {
  it('drops topic prefixes and extra overview lines', () => {
    expect(
      normalizeCustomerOverview(
        [
          'Cancellations — The data indicates 14 starts and 6 cancellations.',
          'Minimum RAM requirement updated for Autodoc — Raised Windows minimum RAM to 16 GB.',
          'Granola format limitations — Local models struggle with formatting.'
        ].join('\n')
      )
    ).toBe(
      'The data indicates 14 starts and 6 cancellations. Raised Windows minimum RAM to 16 GB.'
    )
  })

  it('does not keep a heading that only repeats the topic or body', () => {
    expect(
      distinctNoteTitle('Cancellations', 'The data indicates 14 starts and 6 cancellations.', {
        topic: 'Cancellations'
      })
    ).toBeNull()
    expect(
      distinctNoteTitle(
        'The data indicates 14 starts and 6 cancellations.',
        'The data indicates 14 starts and 6 cancellations.'
      )
    ).toBeNull()
  })

  it('hides Needs Review and repeated topic chrome', () => {
    const cleaned = toCustomerFacingNotes({
      overview: {
        text: 'Cancellations — Starts and cancels looked unusual.\nRAM — Minimum RAM is now 16 GB.'
      },
      keyTakeaways: [
        {
          title: 'Cancellations',
          topic: 'Cancellations',
          text: 'The data indicates 14 starts and 6 cancellations.'
        }
      ],
      sections: [
        {
          title: 'Cancellations',
          keyPoints: [
            {
              title: 'The data indicates 14 starts and 6 cancellations.',
              topic: 'Cancellations',
              text: 'The data indicates 14 starts and 6 cancellations.'
            }
          ],
          supportingDetails: []
        },
        {
          title: 'Needs Review',
          keyPoints: [{ title: 'But logs', topic: 'Needs Review', text: 'But logs show it was running' }],
          supportingDetails: []
        }
      ],
      decisions: [
        { title: 'Um Get the nines', topic: 'Needs Review', text: 'Um Get the nines.' }
      ],
      nextSteps: [
        { title: 'Share Politic', topic: 'Needs Review', text: 'Share Politic.' },
        { title: 'Ping QA', topic: 'Subscription', text: 'Ask Sergio for the smoke-test ETA.' }
      ]
    }, true)

    expect(cleaned.overview?.text).toBe('Starts and cancels looked unusual. Minimum RAM is now 16 GB.')
    expect(cleaned.keyTakeaways[0]?.title).toBeNull()
    expect(cleaned.keyTakeaways[0]?.topic).toBeNull()
    expect(cleaned.sections).toHaveLength(1)
    expect(cleaned.sections[0]?.keyPoints[0]?.title).toBeNull()
    expect(cleaned.sections[0]?.keyPoints[0]?.topic).toBeNull()
    expect(cleaned.decisions).toEqual([])
    expect(cleaned.nextSteps).toEqual([
      expect.objectContaining({
        title: 'Ping QA',
        topic: 'Subscription',
        text: 'Ask Sergio for the smoke-test ETA.'
      })
    ])
  })

  it('moves Other Notes after named chapters', () => {
    const cleaned = toCustomerFacingNotes({
      keyTakeaways: [],
      sections: [
        {
          title: 'Other Notes',
          keyPoints: [{ title: null, topic: 'Other Notes', text: 'The cable was redesigned.' }],
          supportingDetails: []
        },
        {
          title: 'Analytics',
          keyPoints: [{ title: null, topic: 'Analytics', text: 'Login events now include consent.' }],
          supportingDetails: []
        }
      ],
      decisions: [],
      nextSteps: []
    }, true)

    expect(cleaned.sections.map((section) => section.title)).toEqual(['Analytics', 'Other Notes'])
  })

  it('leaves notes unchanged when the Windows display transform is off', () => {
    const notes = {
      overview: { text: 'Cancellations — Starts looked unusual.' },
      keyTakeaways: [],
      sections: [
        {
          title: 'Needs Review',
          keyPoints: [{ title: 'But logs', topic: 'Needs Review', text: 'But logs show it was running' }],
          supportingDetails: []
        }
      ],
      decisions: [],
      nextSteps: []
    }
    expect(toCustomerFacingNotes(notes)).toEqual(notes)
  })
})
