import { describe, expect, it } from 'vitest'

import { collectRanges, distinctRangeKeys } from '../metrics.ts'
import { transformSegments } from '../pipeline.ts'
import { emptySegments, segment } from './fixtures.ts'

describe('range preservation', () => {
  it('never fabricates ranges and never drops an input range from the document', () => {
    const segments = emptySegments()
    segments.decisions = [
      segment({
        id: 'd1',
        bucket: 'decisions',
        title: 'Ship date',
        content: 'Maybe we ship the beta firmware on Friday.',
        startMs: 10_000,
        endMs: 20_000
      }),
      segment({
        id: 'd1-dup',
        bucket: 'decisions',
        title: 'Ship date',
        content: 'Maybe we ship the beta firmware on Friday.',
        startMs: 10_000,
        endMs: 20_000
      })
    ]
    segments.actionItems = [
      segment({
        id: 'a1',
        bucket: 'actionItems',
        title: 'Bundle',
        content: 'I will send the Orion firmware bundle by Friday.',
        startMs: 30_000,
        endMs: 40_000
      })
    ]
    segments.information = [
      segment({
        id: 'i1',
        bucket: 'information',
        title: 'Soak',
        content: 'Clock firmware soak test on Thursday.',
        startMs: 12_000,
        endMs: 18_000
      }),
      segment({
        id: 'i2',
        bucket: 'information',
        title: 'Soak detail',
        content:
          'Clock firmware soak test on Thursday needs the lab bench reserved before noon so the build can flash overnight.',
        startMs: 15_000,
        endMs: 22_000
      })
    ]

    const inputKeys = distinctRangeKeys(
      [...segments.decisions, ...segments.actionItems, ...segments.information].map((entry) => ({
        startMs: entry.sourceStartMs,
        endMs: entry.sourceEndMs
      }))
    )

    const result = transformSegments(segments, {
      dedupClusters: true,
      demoteModality: true,
      nestDetails: true,
      meetingHeadings: true
    })
    const outputKeys = distinctRangeKeys(collectRanges(result.document))
    expect(outputKeys).toEqual(inputKeys)
  })
})
