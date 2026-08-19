import { describe, expect, it } from 'vitest'
import { generateNotesOverview } from '../notes-overview'

describe('generateNotesOverview', () => {
  it('parses overview and takeaways from a JSON response', async () => {
    const result = await generateNotesOverview(
      '## Analytics\n- Collect login events from all users\n',
      async () =>
        JSON.stringify({
          overview: 'The team aligned on login analytics coverage.',
          keyTakeaways: ['Collect login events from all users']
        }),
      [{ startMs: 0, endMs: 10 }]
    )

    expect(result.overview?.text).toBe('The team aligned on login analytics coverage.')
    expect(result.keyTakeaways).toHaveLength(1)
    expect(result.keyTakeaways[0]?.text).toContain('login events')
  })

  it('hides the header when the model returns unusable text', async () => {
    const result = await generateNotesOverview('## Notes\n- Hello\n', async () => 'not json', [
      { startMs: 0, endMs: 10 }
    ])
    expect(result.overview).toBeNull()
    expect(result.keyTakeaways).toEqual([])
  })
})
