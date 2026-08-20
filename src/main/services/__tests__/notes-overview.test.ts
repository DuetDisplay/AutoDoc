import { describe, expect, it } from 'vitest'
import {
  generateNotesOverview,
  notesHeadingsFromMarkdown,
  overviewLooksLikeHeadingList
} from '../notes-overview'

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

  it('retries when the first overview only restates section headings', async () => {
    let calls = 0
    const result = await generateNotesOverview(
      [
        '## Relay hosting capacity review',
        '- Cut idle replicas after the last canary.',
        '## Offline analytics coverage',
        '- Login events now include the consent flag.'
      ].join('\n'),
      async () => {
        calls += 1
        if (calls === 1) {
          return JSON.stringify({
            overview:
              'Relay hosting capacity review and Offline analytics coverage were discussed.',
            keyTakeaways: []
          })
        }
        return JSON.stringify({
          overview: 'Idle replicas will be cut after the canary, and login events now carry consent.',
          keyTakeaways: ['Login events include the consent flag']
        })
      },
      [{ startMs: 0, endMs: 10 }]
    )

    expect(calls).toBe(2)
    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toContain('Idle replicas')
  })

  it('treats a title-join overview as a heading list', () => {
    expect(
      overviewLooksLikeHeadingList('This meeting covered Relay hosting, and Offline analytics.', [
        'Relay hosting',
        'Offline analytics'
      ])
    ).toBe(true)
    expect(
      notesHeadingsFromMarkdown('## Relay hosting capacity review\n## Next Steps\n- Ship it\n')
    ).toEqual(['Relay hosting capacity review'])
  })

  it('returns empty when both attempts are unusable', async () => {
    const result = await generateNotesOverview('## Notes\n- Hello\n', async () => 'not json', [
      { startMs: 0, endMs: 10 }
    ])
    expect(result.usedModel).toBe(false)
    expect(result.overview).toBeNull()
    expect(result.keyTakeaways).toEqual([])
  })

  it('retries after a dropped generate call and keeps the scan context window', async () => {
    const contexts: number[] = []
    let calls = 0
    const result = await generateNotesOverview(
      '## Analytics\n- Collect login events from all users\n',
      async (request) => {
        contexts.push(request.num_ctx)
        calls += 1
        if (calls === 1) throw new Error('runner recycled')
        return JSON.stringify({
          overview: 'The team aligned on login analytics coverage.',
          keyTakeaways: []
        })
      },
      [{ startMs: 0, endMs: 10 }],
      { numCtx: 8192 }
    )

    expect(calls).toBe(2)
    expect(contexts).toEqual([8192, 8192])
    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toBe('The team aligned on login analytics coverage.')
  })
})
