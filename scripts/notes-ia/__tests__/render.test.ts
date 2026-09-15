import { describe, expect, it } from 'vitest'

import { renderDocument } from '../render.ts'
import { formatTimestamp } from '../timestamps.ts'
import { item } from './fixtures.ts'

describe('timestamp rendering', () => {
  it('formats [mm:ss] with minutes that may exceed 59', () => {
    expect(formatTimestamp(0)).toBe('[00:00]')
    expect(formatTimestamp(65_000)).toBe('[01:05]')
    expect(formatTimestamp(3_723_000)).toBe('[62:03]')
  })

  it('suffixes bullets with [mm:ss] and multi-range source counts', () => {
    const markdown = renderDocument({
      title: 'Meeting notes',
      sections: [
        {
          title: 'Firmware',
          kind: 'topic',
          items: [
            item({
              id: 'single',
              title: 'Soak',
              content: 'Clock firmware soak test on Thursday.',
              startMs: 65_000,
              endMs: 80_000
            }),
            {
              id: 'multi',
              title: null,
              content: 'Handshake retries used the spare jig.',
              topic: 'Firmware',
              bucket: 'information',
              owner: null,
              deadline: null,
              sources: [
                { startMs: 120_000, endMs: 130_000 },
                { startMs: 150_000, endMs: 160_000 },
                { startMs: 90_000, endMs: 95_000 }
              ],
              children: []
            }
          ]
        }
      ]
    })

    expect(markdown).toContain('[01:05]')
    expect(markdown).toContain('[01:30] · 3 sources')
    expect(markdown).toMatch(/^- \*\*Soak\*\* — Clock firmware soak test on Thursday\. \[01:05\]$/m)
  })
})
