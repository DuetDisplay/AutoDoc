import { describe, expect, it } from 'vitest'

import { transformPresentation } from '../pipeline.ts'

describe('presentation parsing', () => {
  it('keeps wrapped paragraph continuations on V30-style blocks and suffixes timestamps', () => {
    const presentation = {
      schemaVersion: 1,
      format: 'notes-eval-presentation',
      markdown: [
        '# Meeting notes',
        '## Clock protocol',
        '- Handshake retries used the spare jig.',
        'The spare jig stayed on the bench overnight.',
        '- Soak test flashed the Orion firmware.',
        ''
      ].join('\n'),
      evidence: {
        available: true,
        blocks: [
          {
            location: 'key-point',
            title: null,
            sources: [
              { startMs: 90_000, endMs: 95_000 },
              { startMs: 120_000, endMs: 130_000 }
            ]
          },
          {
            location: 'key-point',
            title: null,
            sources: [{ startMs: 65_000, endMs: 80_000 }]
          }
        ]
      }
    }

    const result = transformPresentation(presentation)
    expect(result.document.sections).toHaveLength(1)
    expect(result.document.sections[0].items).toHaveLength(2)
    expect(result.document.sections[0].items[0].content).toContain('spare jig stayed on the bench')
    expect(result.markdown).toContain('[01:30] · 2 sources')
    expect(result.markdown).toContain('[01:05]')
    expect(result.metrics.rangesIn).toBe(3)
    expect(result.metrics.rangesOut).toBe(3)
  })
})
