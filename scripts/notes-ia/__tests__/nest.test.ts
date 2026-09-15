import { describe, expect, it } from 'vitest'

import { NEST_ADJACENCY_GAP_MS, NEST_JACCARD_THRESHOLD, nestDetails } from '../nest.ts'
import { item } from './fixtures.ts'

describe('topic nesting', () => {
  it('freezes adjacency and Jaccard thresholds', () => {
    expect(NEST_ADJACENCY_GAP_MS).toBe(30_000)
    expect(NEST_JACCARD_THRESHOLD).toBe(0.3)
  })

  it('nests overlapping high-overlap items under the shortest primary', () => {
    const primary = item({
      id: 'short',
      content: 'Clock firmware soak test on Thursday.',
      startMs: 10_000,
      endMs: 20_000,
      topic: 'Firmware'
    })
    const child = item({
      id: 'long',
      content:
        'Clock firmware soak test on Thursday needs the lab bench reserved before noon so the build can flash overnight.',
      startMs: 12_000,
      endMs: 24_000,
      topic: 'Firmware'
    })
    const sibling = item({
      id: 'other-topic',
      content: 'Antenna calibration uses a different checklist.',
      startMs: 12_000,
      endMs: 24_000,
      topic: 'Antenna'
    })

    const { items, nestChildrenAdded } = nestDetails([primary, child, sibling])
    const firmware = items.find((entry) => entry.id === 'short')
    expect(firmware?.children.map((entry) => entry.id)).toEqual(['long'])
    expect(items.some((entry) => entry.id === 'other-topic')).toBe(true)
    expect(nestChildrenAdded).toBe(1)
  })

  it('does not nest when the gap exceeds 30s or Jaccard is low', () => {
    const primary = item({
      id: 'short',
      content: 'Clock firmware soak test on Thursday.',
      startMs: 10_000,
      endMs: 20_000
    })
    const far = item({
      id: 'far',
      content: 'Clock firmware soak test on Thursday needs extra coverage in the log.',
      startMs: 20_000 + NEST_ADJACENCY_GAP_MS + 1,
      endMs: 60_000
    })
    const unlike = item({
      id: 'unlike',
      content: 'Cafeteria catering order for the offsite picnic.',
      startMs: 12_000,
      endMs: 18_000
    })

    const { items, nestChildrenAdded } = nestDetails([primary, far, unlike])
    expect(nestChildrenAdded).toBe(0)
    expect(items).toHaveLength(3)
  })
})
