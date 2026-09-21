import { describe, expect, it } from 'vitest'

import { dedupClusters } from '../dedup.ts'
import { item } from './fixtures.ts'

describe('timestamp-cluster dedup', () => {
  it('keeps the longest text within a priority class, nests distinct text, and drops exact duplicates', () => {
    const range = { startMs: 12_000, endMs: 18_000 }
    const longest = item({
      id: 'long',
      content: 'Ship the Orion clock firmware on Thursday after the soak test completes.',
      startMs: range.startMs,
      endMs: range.endMs
    })
    const nested = item({
      id: 'other',
      title: 'Soak test',
      content: 'Run the soak test before the firmware ship.',
      startMs: range.startMs,
      endMs: range.endMs
    })
    const duplicate = item({
      id: 'dup',
      content: longest.content,
      startMs: range.startMs,
      endMs: range.endMs,
      bucket: 'discussion'
    })
    const unrelated = item({
      id: 'other-range',
      content: 'Unrelated antenna calibration note.',
      startMs: 40_000,
      endMs: 45_000
    })

    const { items, stats } = dedupClusters([longest, nested, duplicate, unrelated])

    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('long')
    expect(items[0].children).toHaveLength(1)
    expect(items[0].children[0].id).toBe('other')
    expect(items.map((entry) => entry.id)).toContain('other-range')
    expect(stats.exactDuplicatesDropped).toBe(1)
    expect(stats.timestampClusterChildren).toBe(1)
  })

  it('prefers a shorter Decision as parent over a longer Information item', () => {
    const range = { startMs: 12_000, endMs: 18_000 }
    const information = item({
      id: 'info',
      content: 'Ship the Orion clock firmware on Thursday after the soak test completes and the lab signs off.',
      startMs: range.startMs,
      endMs: range.endMs,
      bucket: 'information'
    })
    const decision = item({
      id: 'dec',
      content: 'We agreed to ship Y.',
      startMs: range.startMs,
      endMs: range.endMs,
      bucket: 'decisions'
    })

    const { items } = dedupClusters([information, decision])
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('dec')
    expect(items[0].bucket).toBe('decisions')
    expect(items[0].children.map((child) => child.id)).toEqual(['info'])
  })
})
