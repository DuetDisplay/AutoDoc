import { describe, expect, it } from 'vitest'

import { buildBucketHeadings, buildMeetingHeadings } from '../headings.ts'
import { demoteModality } from '../demote.ts'
import { transformSegments } from '../pipeline.ts'
import { emptySegments, item, segment } from './fixtures.ts'

describe('heading construction', () => {
  it('omits empty Decisions and Next Steps after demotion', () => {
    const tentative = item({
      id: 'maybe',
      bucket: 'decisions',
      content: 'Maybe we ship the beta firmware on Friday.',
      startMs: 5_000,
      endMs: 8_000,
      topic: 'Firmware'
    })
    const body = item({
      id: 'info',
      bucket: 'information',
      content: 'The soak bench is reserved at 09:00.',
      startMs: 1_000,
      endMs: 4_000,
      topic: 'Firmware'
    })
    const { items } = demoteModality([tentative, body])
    const { document, emptyHeadingsSuppressed } = buildMeetingHeadings(items)
    expect(document.sections.map((section) => section.title)).toEqual(['Firmware'])
    expect(document.sections.some((section) => section.title === 'Decisions')).toBe(false)
    expect(document.sections.some((section) => section.title === 'Next Steps')).toBe(false)
    expect(emptyHeadingsSuppressed).toBe(2)
  })

  it('omits empty five-bucket headings', () => {
    const onlyInfo = item({
      id: 'info',
      bucket: 'information',
      content: 'The soak bench is reserved at 09:00.',
      startMs: 1_000,
      endMs: 4_000
    })
    const { document, emptyHeadingsSuppressed } = buildBucketHeadings([onlyInfo])
    expect(document.sections.map((section) => section.title)).toEqual(['Information'])
    expect(emptyHeadingsSuppressed).toBe(4)
  })

  it('orders topic sections by earliest range and trails nonempty Decisions', () => {
    const later = item({
      id: 'later',
      bucket: 'information',
      content: 'Antenna calibration uses the spare jig.',
      startMs: 80_000,
      endMs: 90_000,
      topic: 'Antenna'
    })
    const earlier = item({
      id: 'earlier',
      bucket: 'information',
      content: 'Clock firmware soaks overnight.',
      startMs: 10_000,
      endMs: 20_000,
      topic: 'Firmware'
    })
    const decision = item({
      id: 'decided',
      bucket: 'decisions',
      content: 'We agreed to ship the clock protocol on Thursday.',
      startMs: 12_000,
      endMs: 18_000,
      topic: 'Firmware'
    })
    const { document } = buildMeetingHeadings([later, earlier, decision])
    expect(document.sections.map((section) => section.title)).toEqual([
      'Firmware',
      'Antenna',
      'Decisions'
    ])
  })

  it('keeps a shorter Decision in trailing Decisions when clustered with longer Information', () => {
    const segments = emptySegments()
    segments.information = [
      segment({
        id: 'info',
        bucket: 'information',
        title: 'Soak plan',
        content:
          'Clock firmware soak test on Thursday needs the lab bench reserved before noon so the build can flash overnight.',
        startMs: 10_000,
        endMs: 20_000,
        topic: 'Firmware'
      })
    ]
    segments.decisions = [
      segment({
        id: 'dec',
        bucket: 'decisions',
        title: 'Ship',
        content: 'We agreed to ship the clock protocol on Thursday.',
        startMs: 10_000,
        endMs: 20_000,
        topic: 'Firmware'
      })
    ]

    const result = transformSegments(segments, {
      dedupClusters: true,
      demoteModality: true,
      nestDetails: true,
      meetingHeadings: true
    })
    const trailing = result.document.sections.find((section) => section.kind === 'decisions')
    expect(trailing).toBeDefined()
    expect(trailing?.items.some((entry) => entry.id === 'dec')).toBe(true)
    expect(trailing?.items.some((entry) => entry.bucket === 'decisions')).toBe(true)
  })
})
