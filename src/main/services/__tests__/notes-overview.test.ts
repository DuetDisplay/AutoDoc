import { describe, expect, it } from 'vitest'
import {
  generateNotesOverview,
  notesCatalogMarkdown,
  notesHeadingsFromMarkdown,
  overviewConflictsWithCatalog,
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

  it('rejects overviews that invent quantities or harden tentative catalog wording', () => {
    const catalog = [
      '## Email capacity',
      '- The vendor allows up to 10 batches, requiring 334 batches for a million-email list.',
      '- The team should run a 50-50 split in the next release.',
      "- I'm going to change the architecture to support a smaller, faster model on desktop."
    ].join('\n')

    expect(
      overviewConflictsWithCatalog('Signups reached 40 people this week.', catalog)
    ).toBe('invented-quantity')
    expect(
      overviewConflictsWithCatalog(
        'The vendor batch limit is 334 batches for a million-email list.',
        catalog
      )
    ).toBe('quantity-constraint-mismatch')
    expect(
      overviewConflictsWithCatalog('The next release will run a 50-50 split.', catalog)
    ).toBe('modality-promotion')
    expect(
      overviewConflictsWithCatalog(
        'Desktop now has a new architecture supporting a faster model.',
        catalog
      )
    ).toBe('intent-as-state')
    expect(
      overviewConflictsWithCatalog(
        'The vendor allows 10 batches and would need 334 for a million emails. The team should run a 50-50 split, and a faster desktop model is planned.',
        catalog
      )
    ).toBeNull()
    expect(
      overviewConflictsWithCatalog(
        'The 1.1.1 patch addresses the feedback banner.',
        '## Patch\n- 1.1.1 patch includes bug fixes for the feedback banner.\n'
      )
    ).toBeNull()
    expect(
      overviewConflictsWithCatalog(
        'A major campaign is planned after the 1.2 release.',
        '## Campaign\n- Major campaign after 1.2 release\n'
      )
    ).toBeNull()
    expect(
      overviewConflictsWithCatalog(
        'A campaign is planned for LinkedIn, Twitter, and Brevo post-1.2 release.',
        '## Campaign\n- Major campaign after 1.2 release\n'
      )
    ).toBeNull()
  })

  it('retries when the first overview conflicts with the notes catalog', async () => {
    let calls = 0
    const result = await generateNotesOverview(
      '## Release\n- The team should run a 50-50 split in the next release.\n',
      async () => {
        calls += 1
        return calls === 1
          ? JSON.stringify({ overview: 'The next release will run a 50-50 split.' })
          : JSON.stringify({ overview: 'The team should run a 50-50 split in the next release.' })
      },
      [{ startMs: 0, endMs: 10 }],
      { overviewOnly: true }
    )
    expect(calls).toBe(2)
    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toContain('should run a 50-50')
    expect(result.failureReasons[0]).toContain('modality promotion')
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

  it.each([
    ['heading list', 'heading list'],
    ['heading list', 'invalid json'],
    ['invalid json', 'heading list']
  ])('does not accept rejected output after %s followed by %s', async (first, second) => {
    const outputs = [first, second]
    let calls = 0
    const result = await generateNotesOverview(
      '## Hosting\n- Remove idle replicas.\n## Analytics\n- Include consent flags.',
      async () => {
        const kind = outputs[calls++]
        return kind === 'heading list'
          ? JSON.stringify({ overview: 'This meeting covered Hosting and Analytics.' })
          : 'not json'
      },
      [{ startMs: 0, endMs: 10 }],
      { overviewOnly: true }
    )
    expect(calls).toBe(2)
    expect(result.usedModel).toBe(false)
    expect(result.overview).toBeNull()
    expect(result.keyTakeaways).toEqual([])
    expect(result.failureReasons).toHaveLength(2)
  })

  it('returns empty when both attempts are unusable and names each failure', async () => {
    const result = await generateNotesOverview('## Notes\n- Hello\n', async () => 'not json', [
      { startMs: 0, endMs: 10 }
    ])
    expect(result.usedModel).toBe(false)
    expect(result.overview).toBeNull()
    expect(result.keyTakeaways).toEqual([])
    expect(result.failureReasons).toHaveLength(2)
    expect(result.failureReasons[0]).toContain('unparseable response')
    expect(result.failureReasons[1]).toContain('unparseable response')
  })

  it('reports thrown generate errors in the failure reasons', async () => {
    const result = await generateNotesOverview(
      '## Notes\n- Hello\n',
      async () => {
        throw new Error('runner recycled')
      },
      [{ startMs: 0, endMs: 10 }]
    )
    expect(result.usedModel).toBe(false)
    expect(result.failureReasons).toEqual([
      'attempt 1: generate failed: runner recycled',
      'attempt 2: generate failed: runner recycled'
    ])
  })

  it('requests an overview-only JSON object with a 256-token cap', async () => {
    const requests: Array<{ num_predict: number; format: unknown; prompt: string }> = []
    const result = await generateNotesOverview(
      '## Analytics\n- Collect login events from all users\n',
      async (request) => {
        requests.push({
          num_predict: request.num_predict,
          format: request.format,
          prompt: request.prompt
        })
        return JSON.stringify({ overview: 'The team aligned on login analytics coverage.' })
      },
      [{ startMs: 0, endMs: 10 }],
      { overviewOnly: true }
    )
    expect(result.usedModel).toBe(true)
    expect(result.overview?.text).toBe('The team aligned on login analytics coverage.')
    expect(result.keyTakeaways).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.num_predict).toBe(256)
    expect(requests[0]?.format).toMatchObject({ required: ['overview'] })
    expect(requests[0]?.prompt).not.toContain('keyTakeaways')
  })

  it('builds a catalog dump without the copied overview or leftover review notes', () => {
    const markdown = notesCatalogMarkdown({
      overview: { text: 'Cancellations — starts looked odd.', sources: [], provenance: 'generated' },
      keyTakeaways: [
        {
          id: 't1',
          title: '',
          topic: 'Cancellations',
          owner: null,
          deadline: null,
          text: 'Starts and cancels looked unusual.',
          sources: [],
          provenance: 'generated'
        }
      ],
      sections: [
        {
          id: 's1',
          title: 'Needs Review',
          summary: null,
          keyPoints: [
            {
              id: 'junk',
              title: 'Um',
              topic: 'Needs Review',
              owner: null,
              deadline: null,
              text: 'Um Get the nines.',
              sources: [],
              provenance: 'generated'
            }
          ],
          supportingDetails: []
        }
      ],
      decisions: [],
      nextSteps: []
    } as never)
    expect(markdown).toContain('Starts and cancels looked unusual.')
    expect(markdown).not.toContain('Cancellations —')
    expect(markdown).not.toContain('Um Get the nines.')
  })

  it('keeps untitled section bullets without inventing a heading', () => {
    const markdown = notesCatalogMarkdown({
      overview: null,
      keyTakeaways: [],
      sections: [
        {
          id: 's1',
          title: '',
          summary: null,
          keyPoints: [
            {
              id: 'open',
              title: 'Stripe improved',
              topic: null,
              owner: null,
              deadline: null,
              text: 'Stripe was higher week over week.',
              sources: [],
              provenance: 'generated'
            }
          ],
          supportingDetails: []
        }
      ],
      decisions: [],
      nextSteps: []
    } as never)
    expect(markdown).toContain('- Stripe was higher week over week.')
    expect(markdown).not.toMatch(/^##\s*$/m)
  })

  it('requests grammar-constrained JSON output from the model', async () => {
    const formats: unknown[] = []
    await generateNotesOverview(
      '## Notes\n- Hello\n',
      async (request) => {
        formats.push(request.format)
        return JSON.stringify({ overview: 'Recap.', keyTakeaways: [] })
      },
      [{ startMs: 0, endMs: 10 }]
    )
    expect(formats).toHaveLength(1)
    expect(formats[0]).toMatchObject({
      type: 'object',
      required: ['overview', 'keyTakeaways']
    })
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
