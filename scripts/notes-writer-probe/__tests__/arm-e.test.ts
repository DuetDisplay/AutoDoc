import { describe, expect, it } from 'vitest'

import {
  catalogId,
  containsCatalogItemId,
  groupingItemList,
  planArmEGroup,
  planArmERestyle,
  splitLegacyItems,
  toCatalogItem
} from '../arm-e.ts'
import { commitmentFromLegacy, composeDocument, unionNextSteps } from '../compose.ts'
import { ARM_E_RETRY_SEED } from '../constants.ts'
import { extractFacts, extractProperNames, factsPass, missingFacts } from '../facts.ts'
import { fallbackBucketGroups, parseGroupingJson } from '../groups.ts'
import { shapeIssues, stripLegacyDecorations } from '../sanitize.ts'
import type { IaItem } from '../../notes-ia/types.ts'

function item(partial: Partial<IaItem> & { id: string; content: string; bucket: IaItem['bucket'] }): IaItem {
  return {
    title: partial.title ?? null,
    topic: partial.topic ?? 'Clock protocol',
    owner: partial.owner ?? null,
    deadline: partial.deadline ?? null,
    sources: partial.sources ?? [{ startMs: 0, endMs: 1000 }],
    children: partial.children ?? [],
    ...partial
  }
}

const segments = {
  decisions: [
    {
      id: 'd1',
      meetingId: 'm',
      category: 'decision',
      topic: 'Clock',
      title: 'Ship the Orion soak on Thursday',
      content: 'We agreed to ship the Orion soak on Thursday.',
      assignee: 'Alex',
      deadline: null,
      sourceStartMs: 0,
      sourceEndMs: 1000
    },
    {
      id: 'd2',
      meetingId: 'm',
      category: 'decision',
      topic: 'Clock',
      title: 'Maybe rewrite the parser',
      content: 'Maybe we rewrite the parser next quarter.',
      assignee: null,
      deadline: null,
      sourceStartMs: 2000,
      sourceEndMs: 3000
    }
  ],
  actionItems: [
    {
      id: 'a1',
      meetingId: 'm',
      category: 'action_item',
      topic: 'Clock',
      title: 'Send the soak report',
      content: 'Alex will send the soak report on Friday.',
      assignee: 'Alex',
      deadline: 'Friday',
      sourceStartMs: 4000,
      sourceEndMs: 5000
    }
  ],
  information: [
    {
      id: 'n1',
      meetingId: 'm',
      category: 'information',
      topic: 'Clock',
      title: 'HP opt-in 80-95%',
      content: 'HP gaming PCs opt in at 80-95%. [12:34]',
      assignee: null,
      deadline: null,
      sourceStartMs: 6000,
      sourceEndMs: 7000
    }
  ],
  discussion: [
    {
      id: 'n2',
      meetingId: 'm',
      category: 'discussion',
      topic: 'Relay',
      title: 'Relay host is painful',
      content: 'Connecting one-by-one is painful.',
      assignee: null,
      deadline: null,
      sourceStartMs: 8000,
      sourceEndMs: 9000
    }
  ],
  statusUpdates: [
    {
      id: 'n3',
      meetingId: 'm',
      category: 'status_update',
      topic: 'Release',
      title: 'Most PRs ready',
      content: 'Most of the PRs are ready for the build today.',
      assignee: null,
      deadline: null,
      sourceStartMs: 10000,
      sourceEndMs: 11000
    }
  ]
}

describe('Arm E split and grouping', () => {
  it('parses buckets, demotes hedged decisions, and catalogs topical items', () => {
    const split = splitLegacyItems(segments)
    expect(split.topical.map((row) => row.id)).toEqual(['i01', 'i02', 'i03', 'i04'])
    expect(split.decisions).toHaveLength(1)
    expect(split.decisions[0]?.title).toBe('Ship the Orion soak on Thursday')
    expect(split.actions).toHaveLength(1)
    expect(split.demotedCount).toBe(1)
    expect(split.topical.some((row) => row.titleLine.includes('Maybe rewrite'))).toBe(true)
  })

  it('accepts valid grouping JSON and rejects broken assignments', () => {
    const ids = ['i01', 'i02', 'i03', 'i04']
    const ok = parseGroupingJson(
      JSON.stringify({
        groups: [
          { name: 'Release readiness', ids: ['i01', 'i04'] },
          { name: 'Relay hosting', ids: ['i02'] },
          { name: 'Analytics', ids: ['i03'] }
        ]
      }),
      ids
    )
    expect(ok.ok).toBe(true)
    expect(ok.groups).toHaveLength(3)
    expect(parseGroupingJson('not json', ids).reason).toBe('invalid_json')
    expect(
      parseGroupingJson(JSON.stringify({ groups: [{ name: 'Only', ids: ['i01'] }] }), ids).reason
    ).toBe('group_count')
    expect(
      parseGroupingJson(
        JSON.stringify({
          groups: [
            { name: 'A', ids: ['i01'] },
            { name: 'B', ids: ['i02'] },
            { name: 'C', ids: ['i01'] }
          ]
        }),
        ids
      ).reason
    ).toBe('assignment')
  })

  it('remainder-assigns a missing id to the group that shares a content lemma', () => {
    const catalog = [
      toCatalogItem(item({ id: 'a', bucket: 'information', content: 'Alpha fact', title: 'Alpha' }), 0),
      toCatalogItem(item({ id: 'b', bucket: 'information', content: 'Bravo fact', title: 'Bravo' }), 1),
      toCatalogItem(item({ id: 'c', bucket: 'discussion', content: 'Charlie notes', title: 'Charlie' }), 2),
      toCatalogItem(item({ id: 'd', bucket: 'discussion', content: 'Charlie follow-up notes', title: 'Charlie follow-up' }), 3),
      toCatalogItem(item({ id: 'e', bucket: 'statusUpdates', content: 'Echo fact', title: 'Echo' }), 4)
    ]
    const ids = catalog.map((row) => row.id)
    const parsed = parseGroupingJson(
      JSON.stringify({
        groups: [
          { name: 'Facts', ids: ['i01', 'i02'] },
          { name: 'Talk', ids: ['i03'] },
          { name: 'Status', ids: ['i05'] }
        ]
      }),
      ids,
      catalog
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.remainderIds).toEqual(['i04'])
    expect(parsed.groups.find((group) => group.name === 'Talk')?.ids).toEqual(['i03', 'i04'])
  })

  it('puts a remainder item with zero lemma overlap into Other topics', () => {
    const catalog = [
      toCatalogItem(item({ id: 'a', bucket: 'information', content: 'Alpha fact', title: 'Alpha' }), 0),
      toCatalogItem(item({ id: 'b', bucket: 'information', content: 'Bravo fact', title: 'Bravo' }), 1),
      toCatalogItem(item({ id: 'c', bucket: 'discussion', content: 'Charlie fact', title: 'Charlie' }), 2),
      toCatalogItem(item({ id: 'd', bucket: 'discussion', content: 'Unrelated zebra habitat', title: 'Zebra' }), 3),
      toCatalogItem(item({ id: 'e', bucket: 'statusUpdates', content: 'Echo fact', title: 'Echo' }), 4)
    ]
    const ids = catalog.map((row) => row.id)
    const parsed = parseGroupingJson(
      JSON.stringify({
        groups: [
          { name: 'Facts', ids: ['i01', 'i02'] },
          { name: 'Talk', ids: ['i03'] },
          { name: 'Status', ids: ['i05'] }
        ]
      }),
      ids,
      catalog
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.remainderIds).toEqual(['i04'])
    expect(parsed.groups.find((group) => group.name === 'Other topics')?.ids).toEqual(['i04'])
    expect(parsed.groups.find((group) => group.name === 'Talk')?.ids).toEqual(['i03'])
  })

  it('still rejects truncated JSON, duplicates, unknown ids, and >20% remainder', () => {
    const catalog = Array.from({ length: 5 }, (_, index) =>
      toCatalogItem(
        item({
          id: `n${index}`,
          bucket: 'information',
          content: `Fact ${index}`,
          title: `Fact ${index}`
        }),
        index
      )
    )
    const ids = catalog.map((row) => row.id)
    expect(parseGroupingJson('{"groups":[{"name":"A","ids":["i01"]}', ids, catalog).reason).toBe(
      'invalid_json'
    )
    expect(
      parseGroupingJson(
        JSON.stringify({
          groups: [
            { name: 'A', ids: ['i01'] },
            { name: 'B', ids: ['i02'] },
            { name: 'C', ids: ['i01'] }
          ]
        }),
        ids,
        catalog
      ).reason
    ).toBe('assignment')
    expect(
      parseGroupingJson(
        JSON.stringify({
          groups: [
            { name: 'A', ids: ['i01'] },
            { name: 'B', ids: ['i02'] },
            { name: 'C', ids: ['ghost'] }
          ]
        }),
        ids,
        catalog
      ).reason
    ).toBe('unknown_id')
    expect(
      parseGroupingJson(
        JSON.stringify({
          groups: [
            { name: 'A', ids: ['i01'] },
            { name: 'B', ids: ['i02'] },
            { name: 'C', ids: ['i03'] }
          ]
        }),
        ids,
        catalog
      ).reason
    ).toBe('assignment')
  })

  it('falls back to legacy bucket headings', () => {
    const split = splitLegacyItems(segments)
    const groups = fallbackBucketGroups(split.topical)
    expect(groups.map((group) => group.name).sort()).toEqual(
      ['Discussion', 'Information', 'Status Updates'].sort()
    )
    const assigned = groups.flatMap((group) => group.ids).sort()
    expect(assigned).toEqual(split.topical.map((row) => row.id).sort())
  })

  it('builds a grouping prompt from titles only and a restyle prompt from full text', () => {
    const split = splitLegacyItems(segments)
    const group = planArmEGroup(split.topical, 42)
    expect(group.temperature).toBe(0)
    expect(group.request.options.seed).toBe(42)
    expect(group.prompt).toContain('i01:')
    expect(group.prompt.includes('Connecting one-by-one is painful.')).toBe(false)
    const restyle = planArmERestyle('Relay hosting', split.topical.slice(0, 1), 0.4, 42)
    expect(restyle.temperature).toBe(0.4)
    expect(restyle.request.options.seed).toBe(42)
    expect(restyle.prompt).toContain('Do not add any fact, name, number, owner, date, or causal claim that is not in the input.')
    expect(ARM_E_RETRY_SEED).toBe(1337)
    expect(catalogId(0)).toBe('i01')
    expect(containsCatalogItemId('i03 indicates a need for a fix')).toBe(true)
    expect(containsCatalogItemId('iPad identify errors')).toBe(false)
    expect(groupingItemList(split.topical).split('\n')).toHaveLength(split.topical.length)
  })
})

describe('Arm E fact guard and compose', () => {
  it('requires every number and proper name from input in the restyle output', () => {
    const input = 'HP gaming PCs opt in at 80-95% after Alex tracked Orion. Alex will send the soak report.'
    expect(extractFacts(input).numbers).toContain('80-95%')
    expect(extractFacts(input).names).toEqual(expect.arrayContaining(['HP', 'Alex', 'Orion']))
    expect(factsPass(input, 'HP opt-in is 80-95% because Alex tracked Orion.')).toBe(true)
    expect(factsPass(input, 'Opt-in is high because someone tracked soak.')).toBe(false)
    expect(missingFacts(input, 'HP opt-in is high.').numbers).toContain('80-95%')
  })

  it('still rejects true drops of person, OS/product, org, and acronym names', () => {
    expect(factsPass('Alex will merge the Orion patch today.', 'The patch will merge today.')).toBe(
      false
    )
    expect(
      factsPass('Windows and Mac outperforming the Orion baseline.', 'Orion baseline is ahead.')
    ).toBe(false)
    expect(factsPass('HP and QA tracked Orion.', 'Orion was tracked by the team.')).toBe(false)
    expect(factsPass('Acme shipped the RC to QA.', 'The release candidate shipped.')).toBe(false)
    expect(
      factsPass(
        'The vendor Mixpanel beat Vultr after Brevo mailed Google and Gabor tracked Windows and Mac.',
        'The vendor comparison is done.'
      )
    ).toBe(false)
    expect(
      missingFacts(
        'The vendor Mixpanel beat Vultr after Brevo mailed Google and Gabor tracked Windows and Mac.',
        'The vendor comparison is done.'
      ).names
    ).toEqual(
      expect.arrayContaining(['Mixpanel', 'Vultr', 'Brevo', 'Google', 'Gabor', 'Windows', 'Mac'])
    )
  })

  it('does not treat sentence-initial Title Case verbs, gerunds, or heading echoes as names', () => {
    const falsePositives = [
      'Aims',
      'Relies',
      'Highlights',
      'Makes',
      'Would',
      'Considering',
      'Making',
      'Remaining',
      'Description',
      'Downed',
      'Positive',
      'Results',
      'Comparison',
      'Has',
      'Adding',
      'Identified',
      'Task'
    ]
    const input = [
      '* Aims to ship after the soak.',
      '* Relies on the existing soak.',
      '* Highlights include the soak.',
      '* Makes the soak easier.',
      '* Would consider the soak.',
      '* Considering the soak next.',
      '* Making the soak shorter.',
      '* Remaining soak work is light.',
      '* Description covers the soak.',
      '* Downed soak nodes recovered.',
      '* Positive soak signal held.',
      '* Results from the soak arrived.',
      '* Comparison favors the soak.',
      '* Has a soak owner already.',
      '* Adding soak coverage tomorrow.',
      '* Identified soak gaps today.',
      'Task'
    ].join('\n')
    const names = extractProperNames(input)
    for (const token of falsePositives) {
      expect(names).not.toContain(token)
    }
    expect(
      factsPass(
        '* Aims to keep Mixpanel after Google mailed Brevo.',
        '* Keep Mixpanel after Google mailed Brevo.'
      )
    ).toBe(true)
    expect(
      factsPass(
        'The vendor Mixpanel beat Vultr after Brevo mailed Google.',
        'The vendor beat Vultr after Brevo mailed a provider.'
      )
    ).toBe(false)
    expect(extractProperNames('Follow up next week (Gabor).')).toContain('Gabor')
    expect(extractProperNames('Keep the Clock Protocol after Orion.')).toContain('Clock Protocol')
    expect(extractProperNames('The vendor Google Cloud beat Vultr.')).toEqual(
      expect.arrayContaining(['Google Cloud', 'Vultr'])
    )
  })

  it('does not require heading spans, discourse words, trailing Them, or markdown glue', () => {
    const heading = 'Relay Hosting Pain Points Review Tasks\nClock Protocol'
    expect(extractProperNames(heading).some((name) => name.split(/\s+/u).length >= 5)).toBe(false)
    expect(extractProperNames('However Regardless Recent Review\nNext Steps Pros')).toEqual([])
    expect(factsPass('Relay Hosting Them needs Orion.', 'Relay hosting still needs **Orion**.')).toBe(
      true
    )
    expect(factsPass('Keep HP and Orion.', 'Keep **HP** and Orion.')).toBe(true)
    expect(factsPass('Clock Protocol\nRelay Hosting', 'Clock protocol. Relay hosting.')).toBe(true)
    expect(factsPass('Relay Hosting Them needs Orion.', 'Hosting still needs work.')).toBe(false)
  })

  it('matches ranges by endpoints, thousands separators both ways, and currency phrasing', () => {
    expect(factsPass('HP opt-in is 80-95%.', 'HP opt-in sits between 80% and 95%.')).toBe(true)
    expect(factsPass('Cap is 3,000 emails.', 'Cap is 3000 emails.')).toBe(true)
    expect(factsPass('Cap is 3000 emails.', 'Cap is 3,000 emails.')).toBe(true)
    expect(factsPass('Seat cost is $1.', 'Seat cost is 1 dollar.')).toBe(true)
    expect(factsPass('HP opt-in is 80-95%.', '80 users joined. Latency is 95ms.')).toBe(false)
    expect(factsPass('Cap is 3,000 emails.', 'There is a cap.')).toBe(false)
  })

  it('records missing facts against a rejected restyle even when the body would fall back', () => {
    const input = 'Keep 42 widgets for Orion.'
    const dropped = '* Keep widgets.'
    expect(factsPass(input, dropped)).toBe(false)
    expect(missingFacts(input, dropped).names).toContain('Orion')
    expect(missingFacts(input, dropped).numbers).toContain('42')
  })

  it('unions next steps, drops placeholder owners, and strips timestamps', () => {
    const legacy = [
      item({
        id: 'a1',
        bucket: 'actionItems',
        title: 'Send the soak report',
        content: 'Alex will send the soak report on Friday. [12:34]',
        owner: 'Alex'
      })
    ]
    const extracted = [
      {
        index: 1,
        raw: 'Send the soak report',
        action: 'Send the soak report',
        owner: 'Owner',
        rationale: 'So QA can start Friday.'
      }
    ]
    const union = unionNextSteps(legacy, extracted)
    expect(union).toHaveLength(1)
    expect(union[0]?.owner).toBe('Alex')
    expect(commitmentFromLegacy(legacy[0]!).action).not.toContain('[12:34]')
    expect(stripLegacyDecorations('Hello [them] world [07:22]')).toBe('Hello world')
  })

  it('composes topical sections then Decisions then Next Steps', () => {
    const markdown = composeDocument({
      title: 'Standup',
      sections: [{ name: 'Orion soak', markdown: '* HP opt-in is 80-95%.\n' }],
      decisions: [
        item({
          id: 'd1',
          bucket: 'decisions',
          title: 'Ship Thursday',
          content: 'We agreed to ship the Orion soak on Thursday.',
          owner: 'Alex'
        })
      ],
      nextSteps: [
        {
          index: 1,
          raw: 'x',
          action: 'Send the soak report',
          owner: 'Alex',
          rationale: 'So QA can start Friday.'
        }
      ]
    })
    expect(markdown.indexOf('## Orion soak')).toBeLessThan(markdown.indexOf('## Decisions'))
    expect(markdown.indexOf('## Decisions')).toBeLessThan(markdown.indexOf('## Next Steps'))
    expect(markdown).toContain('* **Send the soak report** (Alex) — So QA can start Friday.')
    expect(markdown.includes('Owner: null')).toBe(false)
    expect(shapeIssues(markdown)).toEqual([])
  })

  it('falls back to unrestyled input items when the guard would drop facts', () => {
    const input = 'Keep 42 widgets for Orion.'
    const dropped = '* Keep widgets.'
    expect(factsPass(input, dropped)).toBe(false)
  })
})
