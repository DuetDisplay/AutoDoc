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

    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toBe('The team aligned on login analytics coverage.')
    expect(result.keyTakeaways).toHaveLength(1)
    expect(result.keyTakeaways[0]?.text).toContain('login events')
  })

  it('retries once when the first response is unusable', async () => {
    let calls = 0
    const result = await generateNotesOverview(
      '## Analytics\n- Collect login events from all users\n',
      async () => {
        calls += 1
        if (calls === 1) return 'not json'
        return JSON.stringify({
          overview: 'The team aligned on login analytics coverage.',
          keyTakeaways: ['Collect login events from all users']
        })
      },
      [{ startMs: 0, endMs: 10 }]
    )

    expect(calls).toBe(2)
    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toBe('The team aligned on login analytics coverage.')
  })

  it('returns empty when both attempts are unusable', async () => {
    const result = await generateNotesOverview('## Notes\n- Hello\n', async () => 'not json', [
      { startMs: 0, endMs: 10 }
    ])
    expect(result.usedModel).toBe(false)
    expect(result.overview).toBeNull()
    expect(result.keyTakeaways).toEqual([])
  })
})
