import { describe, expect, it } from 'vitest'
import {
  collectNotesV2SearchEntries,
  formatNotesV2SearchBody,
  matchNotesV2SearchEntries
} from '../notes-search-text'

const v2Document = {
  schemaVersion: 2,
  overview: { text: 'The team aligned on billing migration.' },
  keyTakeaways: [{ id: 't1', text: 'Ship the invoice export' }],
  sections: [
    {
      id: 's1',
      title: 'Billing',
      keyPoints: [{ id: 'p1', text: 'Move invoices off the legacy importer.' }],
      supportingDetails: [{ id: 'd1', title: null, text: 'Agreed: keep the old CSV for one week' }]
    }
  ],
  decisions: [],
  nextSteps: [{ id: 'n1', title: 'Review the billing PR', text: 'Review the billing PR', owner: 'Priya' }]
}

describe('notes-search-text', () => {
  it('flattens V2 notes into searchable entries, including next steps as action items', () => {
    const entries = collectNotesV2SearchEntries(v2Document)
    expect(entries.map((entry) => entry.category)).toEqual([
      'information',
      'information',
      'information',
      'information',
      'actionItems'
    ])
    expect(entries.some((entry) => entry.content.includes('legacy importer'))).toBe(true)
    expect(entries.some((entry) => entry.category === 'actionItems' && entry.owner === 'Priya')).toBe(
      true
    )
  })

  it('matches an organic section heading even when the words are not in the bullet', () => {
    const entries = collectNotesV2SearchEntries(v2Document)
    expect(matchNotesV2SearchEntries(entries, ['billing'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'segment',
          category: 'information'
        })
      ])
    )
  })

  it('ignores writer-extract wording when matching V2 text', () => {
    const entries = collectNotesV2SearchEntries(v2Document)
    const matches = matchNotesV2SearchEntries(entries, ['invoice', 'export'])
    expect(matches).toEqual([
      { type: 'segment', text: 'Key takeaway: Ship the invoice export', category: 'information' }
    ])
    expect(matchNotesV2SearchEntries(entries, ['writer extract'])).toEqual([])
  })

  it('formats Ask AI context with V1-compatible category headings', () => {
    const body = formatNotesV2SearchBody(collectNotesV2SearchEntries(v2Document))
    expect(body).toContain('### information')
    expect(body).toContain('### actionItems')
    expect(body).toContain('Move invoices off the legacy importer.')
    expect(body).toContain('Owner: Priya')
  })

  it('returns nothing for non-V2 payloads so Search can fall back to segments.json', () => {
    expect(collectNotesV2SearchEntries({ schemaVersion: 1, sections: [] })).toEqual([])
    expect(collectNotesV2SearchEntries(null)).toEqual([])
  })
})
