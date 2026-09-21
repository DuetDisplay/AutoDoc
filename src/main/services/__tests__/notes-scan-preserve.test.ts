import { describe, expect, it } from 'vitest'
import { toCatalogItem } from '../../../../scripts/notes-writer-probe/arm-e.ts'
import type { CatalogItem } from '../../../../scripts/notes-writer-probe/groups.ts'
import type { IaItem } from '../../../../scripts/notes-ia/types.ts'
import type { MeetingNotesContent, NoteItem, NoteSection } from '../../../shared/types'
import {
  appendTranscriptQuantities,
  appendTranscriptTickets,
  chooseScanGroups,
  dropAssertiveTakeaways,
  entitiesPreserved,
  isGenericGroupName,
  preserveWriterEntities,
  ticketsInText,
  writerQuantitiesInText
} from '../notes-scan-preserve'

function iaItem(partial: Partial<IaItem> & Pick<IaItem, 'id' | 'content'>): IaItem {
  return {
    title: partial.title ?? null,
    topic: partial.topic ?? null,
    bucket: partial.bucket ?? 'information',
    owner: null,
    deadline: null,
    sources: partial.sources ?? [{ startMs: 1000, endMs: 2000 }],
    children: [],
    ...partial
  }
}

function catalog(items: IaItem[]): CatalogItem[] {
  return items.map((item, index) => toCatalogItem(item, index))
}

function item(partial: Partial<NoteItem> & Pick<NoteItem, 'id' | 'text'>): NoteItem {
  return {
    title: null,
    topic: null,
    owner: null,
    deadline: null,
    sources: [],
    provenance: 'generated',
    completed: false,
    ...partial
  }
}

function section(partial: Partial<NoteSection> & Pick<NoteSection, 'id' | 'title'>): NoteSection {
  return {
    summary: null,
    keyPoints: [],
    supportingDetails: [],
    ...partial
  }
}

function notes(partial: Partial<MeetingNotesContent> = {}): MeetingNotesContent {
  return {
    overview: null,
    keyTakeaways: [],
    sections: [section({ id: 's1', title: 'Notes' })],
    decisions: [],
    nextSteps: [],
    ...partial
  }
}

describe('isGenericGroupName', () => {
  it('rejects the writer taxonomy that produced unusable headings', () => {
    expect(isGenericGroupName('Technical Architecture')).toBe(true)
    expect(isGenericGroupName('Pricing & Costs')).toBe(true)
    expect(isGenericGroupName('Release Planning')).toBe(true)
    expect(isGenericGroupName('Cancellation Rate Investigation')).toBe(false)
  })
})

describe('entitiesPreserved', () => {
  it('requires tickets and writer quantities to survive a rewrite', () => {
    const input = 'Local discovery: 14 starts, six cancels. Track DD1417.'
    expect(entitiesPreserved(input, 'Local discovery is still noisy. Track DD1417.')).toBe(false)
    expect(entitiesPreserved(input, '14 starts and six cancels. DD-1417 remains open.')).toBe(true)
  })
})

describe('chooseScanGroups', () => {
  it('discards LLM groups that only reuse generic writer headings', () => {
    const rows = catalog([
      iaItem({
        id: 'a',
        title: 'Investigate Web Socket impact on cancel rate',
        content: 'There are currently 14 starts, six cancels in the last day.',
        topic: 'Pricing & Costs'
      }),
      iaItem({
        id: 'b',
        title: 'Use Mirror terminology for iOS to desktop',
        content: 'Matt prefers mirror because it implies cast and control.',
        topic: 'Technical Architecture'
      }),
      iaItem({
        id: 'c',
        title: 'Keep the latest build this week',
        content: 'Use the latest build this week and release next week as scheduled.',
        topic: 'Release Planning'
      })
    ])

    const chosen = chooseScanGroups(
      [
        { name: 'Technical Architecture', ids: [rows[1]!.id] },
        { name: 'Pricing & Costs', ids: [rows[0]!.id] },
        { name: 'Release Planning', ids: [rows[2]!.id] }
      ],
      [
        { name: 'Technical Architecture', ids: [rows[1]!.id] },
        { name: 'Pricing & Costs', ids: [rows[0]!.id] },
        { name: 'Release Planning', ids: [rows[2]!.id] }
      ],
      rows
    )

    expect(chosen.usedSpecificCatalog).toBe(true)
    expect(chosen.groups.every((group) => !isGenericGroupName(group.name))).toBe(true)
    expect(chosen.groups.some((group) => /mirror|web socket|build/i.test(group.name))).toBe(true)
  })

  it('keeps LLM groups when the names are already specific', () => {
    const rows = catalog([
      iaItem({ id: 'a', title: 'A', content: 'alpha topic one', topic: 'A' }),
      iaItem({ id: 'b', title: 'B', content: 'beta topic two', topic: 'B' })
    ])
    const llm = [
      { name: 'Cancellation Rate Investigation', ids: [rows[0]!.id] },
      { name: 'Build and Feature Updates', ids: [rows[1]!.id] }
    ]
    const chosen = chooseScanGroups(llm, [], rows)
    expect(chosen.groups).toEqual(llm)
    expect(chosen.usedSpecificCatalog).toBe(false)
  })
})

describe('preserveWriterEntities', () => {
  it('reinserts writer quantities and tickets the restyle dropped', () => {
    const rows = catalog([
      iaItem({
        id: 'qty',
        title: 'Local discovery board',
        content: 'There are currently 14 starts, six cancels in the last day.',
        sources: [{ startMs: 4000, endMs: 48000 }]
      }),
      iaItem({
        id: 'ticket',
        title: 'Gather logs for DD1417',
        content: 'Norbert is gathering logs from users for issue DD1417.',
        sources: [{ startMs: 19000, endMs: 22000 }]
      })
    ])
    const result = preserveWriterEntities(notes(), rows)
    const details = result.sections[0]?.supportingDetails ?? []
    expect(details.some((row) => /14 starts/i.test(row.text))).toBe(true)
    expect(ticketsInText(details.map((row) => row.text).join(' '))).toContain('DD1417')
  })

  it('reinserts Windows memory sizes the scan dropped', () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const rows = catalog([
        iaItem({
          id: 'ram',
          title: 'Auto Doc minimum RAM updated to 16GB for Windows',
          content:
            'The minimum system specification for Windows was raised from 8GB to 16GB.',
          sources: [{ startMs: 1_061_000, endMs: 1_071_000 }]
        })
      ])
      const result = preserveWriterEntities(notes(), rows)
      const details = result.sections[0]?.supportingDetails ?? []
      expect(details.some((row) => /16\s*gb/i.test(row.text))).toBe(true)
      expect(details.some((row) => /8\s*gb/i.test(row.text))).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })
})

describe('appendTranscriptQuantities', () => {
  it('on Windows reinserts spoken counts and dotted versions from the transcript', () => {
    const result = appendTranscriptQuantities(
      notes(),
      [
        {
          text: "Yeah, I mean there's fourteen Starts and Six cancels.",
          startMs: 22_000,
          endMs: 26_000
        },
        {
          text: 'So I made a PR and got a one dot one dot three out release.',
          startMs: 1_040_000,
          endMs: 1_050_000
        }
      ],
      'win32'
    )
    const text = (result.sections[0]?.supportingDetails ?? []).map((row) => row.text).join(' ')
    expect(text).toMatch(/fourteen Starts/i)
    expect(text).toMatch(/one dot one dot three/i)
  })

  it('does nothing on macOS', () => {
    const result = appendTranscriptQuantities(
      notes(),
      [{ text: 'Raised the minimum to 16GB.', startMs: 1000, endMs: 2000 }],
      'darwin'
    )
    expect(result.sections[0]?.supportingDetails).toEqual([])
  })
})

describe('appendTranscriptTickets', () => {
  it('adds transcript-only ticket IDs without an LLM', () => {
    const result = appendTranscriptTickets(notes(), [
      {
        text: 'And the linear for this feature request is DD1450.',
        startMs: 1_917_000,
        endMs: 1_920_000
      }
    ])
    const text = result.sections[0]?.supportingDetails[0]?.text ?? ''
    expect(text).toContain('DD1450')
    expect(result.sections[0]?.supportingDetails[0]?.sources[0]?.startMs).toBe(1_917_000)
  })
})

describe('dropAssertiveTakeaways', () => {
  it('removes takeaways that assert agreement', () => {
    const result = dropAssertiveTakeaways(
      notes({
        keyTakeaways: [
          item({ id: 't1', text: 'Team agreed to adopt the Mirror concept' }),
          item({ id: 't2', text: 'Local discovery still needs monitoring' })
        ]
      })
    )
    expect(result.keyTakeaways.map((row) => row.text)).toEqual([
      'Local discovery still needs monitoring'
    ])
  })
})

describe('writer-card entity extractors', () => {
  it('reads the standup quantity phrasing and sync ticket id from card text', () => {
    const standup =
      '[Them] mentioned that there are currently 14 starts, six cancels in the last day.'
    const sync = 'Norbert is gathering logs from users for issue DD1417.'
    expect(writerQuantitiesInText(standup).some((value) => /14 starts/i.test(value))).toBe(true)
    expect(writerQuantitiesInText(standup).some((value) => /six cancels/i.test(value))).toBe(true)
    expect(ticketsInText(sync)).toContain('DD1417')
  })

  it('on Windows also keeps memory sizes and spoken dotted versions', () => {
    const ram = 'Raised the Windows minimum from 8GB to 16GB.'
    const spoken = 'Use the four-three-five build for the week.'
    expect(writerQuantitiesInText(ram, 'win32').some((value) => /8\s*gb/i.test(value))).toBe(true)
    expect(writerQuantitiesInText(ram, 'win32').some((value) => /16\s*gb/i.test(value))).toBe(true)
    expect(writerQuantitiesInText(spoken, 'win32').some((value) => /four-three-five/i.test(value))).toBe(
      true
    )
    expect(writerQuantitiesInText(ram, 'darwin')).toEqual([])
  })
})
