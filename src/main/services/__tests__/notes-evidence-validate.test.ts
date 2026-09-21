import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import type { MeetingNotesContent, NoteItem, NoteSection } from '../../../shared/types'
import {
  appendUncoveredLedger,
  applyClaimVerdicts,
  buildLedgerPrompt,
  buildVerificationPrompt,
  chunkTranscript,
  collectEvidenceClaims,
  dedupeLedger,
  documentCoversLedgerEntry,
  extractLedger,
  filterLedgerEntries,
  isPlausiblePersonName,
  LEDGER_CHUNK_CHAR_LIMIT,
  retrieveEvidenceWindows,
  sectionClaimId,
  supplementLedgerTickets,
  validateNotesAgainstTranscript,
  type ClaimVerdictRecord,
  type LedgerEntry,
  type TranscriptRow
} from '../notes-evidence-validate'
import { isPlausiblePersonOwner } from '../notes-scan-markdown'

function row(
  partial: Partial<TranscriptRow> & Pick<TranscriptRow, 'text'>
): TranscriptRow {
  return {
    speaker: partial.speaker ?? 'Speaker',
    text: partial.text,
    startMs: partial.startMs ?? 0,
    endMs: partial.endMs ?? 1000
  }
}

function item(partial: Partial<NoteItem> & Pick<NoteItem, 'id' | 'text'>): NoteItem {
  return {
    title: partial.title ?? partial.text,
    topic: partial.topic ?? null,
    owner: partial.owner ?? null,
    deadline: null,
    sources: partial.sources ?? [{ startMs: 0, endMs: 1000 }],
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

function content(partial: Partial<MeetingNotesContent> = {}): MeetingNotesContent {
  return {
    overview: null,
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: [],
    ...partial
  }
}

function ledger(partial: Partial<LedgerEntry> & Pick<LedgerEntry, 'text'>): LedgerEntry {
  return {
    kind: 'decision',
    owner: null,
    quote: partial.quote ?? partial.text,
    startMs: 1_000,
    endMs: 2_000,
    ...partial
  }
}

function detailId(text: string): string {
  return `detail-${createHash('sha256').update(`\n${text}`).digest('hex').slice(0, 16)}`
}

describe('chunkTranscript', () => {
  it('keeps row boundaries and splits before exceeding the size cap', () => {
    const rows = [
      row({ speaker: 'A', text: 'x'.repeat(4000), startMs: 0, endMs: 1_000 }),
      row({ speaker: 'B', text: 'y'.repeat(4000), startMs: 1_000, endMs: 2_000 }),
      row({ speaker: 'C', text: 'short closer', startMs: 2_000, endMs: 3_000 })
    ]

    const chunks = chunkTranscript(rows, LEDGER_CHUNK_CHAR_LIMIT)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.rows.map((entry) => entry.speaker)).toEqual(['A'])
    expect(chunks[1]?.rows.map((entry) => entry.speaker)).toEqual(['B', 'C'])
    expect(chunks[0]?.startMs).toBe(0)
    expect(chunks[0]?.endMs).toBe(1_000)
    expect(chunks[1]?.startMs).toBe(1_000)
    expect(chunks[1]?.endMs).toBe(3_000)
    expect(chunks[0]?.text).toContain('A:')
    expect(chunks[0]?.text).not.toContain('B:')
  })

  it('keeps a single oversized row intact', () => {
    const rows = [row({ text: 'z'.repeat(LEDGER_CHUNK_CHAR_LIMIT + 500), startMs: 5, endMs: 15 })]
    const chunks = chunkTranscript(rows, LEDGER_CHUNK_CHAR_LIMIT)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.rows).toHaveLength(1)
    expect(chunks[0]?.startMs).toBe(5)
    expect(chunks[0]?.endMs).toBe(15)
  })
})

describe('filterLedgerEntries quote guard', () => {
  it('drops hallucinated quotes and empty text', () => {
    const chunkText = '[00:10] Chris: We will ship 4.3.5 tomorrow morning after QA signs off.'
    const kept = filterLedgerEntries(
      [
        {
          kind: 'decision',
          text: 'Release 4.3.5 tomorrow morning',
          owner: null,
          quote: 'ship 4.3.5 tomorrow morning'
        },
        {
          kind: 'decision',
          text: 'Adopt the Mirror concept',
          owner: 'Chris',
          quote: 'everyone agreed to adopt Mirror immediately'
        },
        {
          kind: 'quantity',
          text: '',
          owner: null,
          quote: 'ship 4.3.5 tomorrow morning'
        }
      ],
      chunkText,
      { startMs: 10_000, endMs: 20_000 }
    )

    expect(kept).toEqual([
      {
        kind: 'decision',
        text: 'Release 4.3.5 tomorrow morning',
        owner: null,
        quote: 'ship 4.3.5 tomorrow morning',
        startMs: 10_000,
        endMs: 20_000
      }
    ])
  })
})

describe('dedupeLedger', () => {
  it('drops near-identical entries that share most content tokens', () => {
    const kept = dedupeLedger([
      ledger({
        text: 'Release version 4.3.5 tomorrow morning after QA',
        quote: 'ship 4.3.5 tomorrow morning after QA'
      }),
      ledger({
        text: 'Release 4.3.5 tomorrow morning after QA signoff',
        quote: 'we will ship 4.3.5 tomorrow morning after QA'
      }),
      ledger({
        kind: 'quantity',
        text: 'Fourteen starts and six cancels',
        quote: '14 starts, 6 cancels'
      })
    ])

    expect(kept).toHaveLength(2)
    expect(kept[0]?.text).toContain('4.3.5')
    expect(kept[1]?.kind).toBe('quantity')
  })
})

describe('retrieveEvidenceWindows', () => {
  it('picks the top overlapping windows that mention the claim tokens', () => {
    const rows: TranscriptRow[] = []
    for (let index = 0; index < 16; index += 1) {
      const aboutMirror = index >= 8 && index <= 13
      rows.push(
        row({
          speaker: aboutMirror ? 'Chris' : 'Pat',
          text: aboutMirror
            ? 'We should consider the Mirror concept for reconnect.'
            : 'Weather standup filler about lunch plans.',
          startMs: index * 1_000,
          endMs: index * 1_000 + 900
        })
      )
    }

    const windows = retrieveEvidenceWindows('adopt the Mirror concept for reconnect', rows)

    expect(windows.length).toBeGreaterThanOrEqual(1)
    expect(windows.length).toBeLessThanOrEqual(2)
    expect(windows[0]?.score).toBeGreaterThan(0)
    expect(windows[0]?.rows.some((entry) => entry.text.includes('Mirror'))).toBe(true)
    expect(windows[0]?.score).toBeGreaterThanOrEqual(windows[1]?.score ?? 0)
    expect(windows[0]?.rows[0]?.startMs).toBeGreaterThanOrEqual(4_000)
  })

  it('extends each selected window by the next six rows', () => {
    const rows: TranscriptRow[] = []
    for (let index = 0; index < 14; index += 1) {
      rows.push(
        row({
          speaker: index < 8 ? 'Chris' : 'Pat',
          text:
            index < 8
              ? "So we're keeping the same Mirror terminology."
              : `Deferral follow-up row ${index} for later feedback.`,
          startMs: index * 1_000,
          endMs: index * 1_000 + 900
        })
      )
    }

    const windows = retrieveEvidenceWindows("The team decided to use the term 'mirror'", rows)
    const top = windows[0]
    expect(top).toBeDefined()
    const texts = top?.rows.map((entry) => entry.text) ?? []
    expect(texts[0]).toContain('Mirror terminology')
    expect(texts.some((text) => text.includes('Deferral follow-up row 8'))).toBe(true)
    expect(texts.some((text) => text.includes('Deferral follow-up row 13'))).toBe(true)
    expect(texts.some((text) => text.includes('Deferral follow-up row 14'))).toBe(false)
  })

  it('does not extend past the end of the transcript', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({
        text: `Mirror reconnect row ${index}`,
        startMs: index * 1_000,
        endMs: index * 1_000 + 500
      })
    )

    const windows = retrieveEvidenceWindows('Mirror reconnect', rows)
    const lastMs = Math.max(...windows.flatMap((window) => window.rows.map((entry) => entry.endMs)))
    expect(lastMs).toBe(9_500)
    expect(windows.every((window) => window.rows.length <= rows.length)).toBe(true)
    expect(windows.flatMap((window) => window.rows).every((entry) => entry.endMs <= 9_500)).toBe(true)
  })
})

describe('isPlausiblePersonName', () => {
  it('accepts short capitalized names and rejects junk owners', () => {
    expect(isPlausiblePersonName('Chris')).toBe(true)
    expect(isPlausiblePersonName('Pat Lee')).toBe(true)
    expect(isPlausiblePersonName('Determine, English')).toBe(false)
    expect(isPlausiblePersonName('Agent 7')).toBe(false)
    expect(isPlausiblePersonName(null)).toBe(false)
    expect(isPlausiblePersonName('Yeah')).toBe(false)
    expect(isPlausiblePersonName('(Yeah)')).toBe(false)
    expect(isPlausiblePersonOwner('Yeah')).toBe(false)
    expect(isPlausiblePersonOwner('(Yeah)')).toBe(false)
  })
})

describe('buildVerificationPrompt', () => {
  it('does not include a notes_owner line', () => {
    const prompt = buildVerificationPrompt([
      {
        claim: {
          id: 'next-review',
          kind: 'nextStep',
          text: 'Review the offline analytics PR',
          owner: 'Yeah'
        },
        windows: []
      }
    ])
    expect(prompt).not.toMatch(/notes_owner/i)
    expect(prompt).not.toContain('Yeah')
    expect(prompt).toContain('CLAIM next-review')
    expect(prompt).toContain('text: Review the offline analytics PR')
    expect(prompt).toContain('deferred for later feedback')
    expect(prompt).toContain('explicit final agreement, completed fact, or unambiguous decision')
  })
})

describe('applyClaimVerdicts', () => {
  const mirror = item({
    id: 'takeaway-mirror',
    text: 'Team agreed to adopt the Mirror concept'
  })
  const discussed = item({
    id: 'takeaway-discussed',
    text: 'Team discussed a foreground reconnect option'
  })
  const next = item({
    id: 'next-review',
    title: 'Review the offline analytics PR',
    text: 'Review the offline analytics PR',
    owner: 'Norbert'
  })

  function verdicts(rows: ClaimVerdictRecord[]): Map<string, ClaimVerdictRecord> {
    return new Map(rows.map((row) => [row.id, row]))
  }

  it('removes a takeaway that asserts agreement when the verdict is only proposed', () => {
    const result = applyClaimVerdicts(
      content({ keyTakeaways: [mirror] }),
      verdicts([{ id: 'takeaway-mirror', verdict: 'proposed', owner: null }])
    )
    expect(result.content.keyTakeaways).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('keeps a proposed takeaway that does not assert agreement', () => {
    const result = applyClaimVerdicts(
      content({ keyTakeaways: [discussed] }),
      verdicts([{ id: 'takeaway-discussed', verdict: 'proposed', owner: null }])
    )
    expect(result.content.keyTakeaways).toEqual([discussed])
    expect(result.dropped).toBe(0)
  })

  it('removes unsupported takeaways and next steps', () => {
    const result = applyClaimVerdicts(
      content({ keyTakeaways: [discussed], nextSteps: [next] }),
      verdicts([
        { id: 'takeaway-discussed', verdict: 'unsupported', owner: null },
        { id: 'next-review', verdict: 'unsupported', owner: 'Norbert' }
      ])
    )
    expect(result.content.keyTakeaways).toEqual([])
    expect(result.content.nextSteps).toEqual([])
    expect(result.dropped).toBe(2)
  })

  it('keeps supported takeaways', () => {
    const result = applyClaimVerdicts(
      content({ keyTakeaways: [mirror] }),
      verdicts([{ id: 'takeaway-mirror', verdict: 'supported', owner: null }])
    )
    expect(result.content.keyTakeaways).toEqual([mirror])
  })

  it('strips a next-step owner when the verdict owner is null', () => {
    const result = applyClaimVerdicts(
      content({ nextSteps: [next] }),
      verdicts([{ id: 'next-review', verdict: 'supported', owner: null }])
    )
    expect(result.content.nextSteps[0]?.owner).toBeNull()
    expect(result.ownersStripped).toBe(1)
  })

  it('rejects a junk verdict owner and strips the original', () => {
    const result = applyClaimVerdicts(
      content({ nextSteps: [next] }),
      verdicts([{ id: 'next-review', verdict: 'proposed', owner: 'Determine, English' }])
    )
    expect(result.content.nextSteps[0]?.owner).toBeNull()
    expect(result.ownersStripped).toBe(1)
  })

  it('sets a plausible verdict owner on a kept next step', () => {
    const result = applyClaimVerdicts(
      content({ nextSteps: [next] }),
      verdicts([{ id: 'next-review', verdict: 'supported', owner: 'Chris' }])
    )
    expect(result.content.nextSteps[0]?.owner).toBe('Chris')
    expect(result.ownersStripped).toBe(1)
  })

  it('leaves unvalidated claims unchanged', () => {
    const result = applyClaimVerdicts(content({ keyTakeaways: [mirror], nextSteps: [next] }), new Map())
    expect(result.content.keyTakeaways).toEqual([mirror])
    expect(result.content.nextSteps).toEqual([next])
    expect(result.dropped).toBe(0)
    expect(result.ownersStripped).toBe(0)
  })

  it('collects assertive section bullets and removes them when only proposed', () => {
    const decided = item({
      id: 'point-mirror',
      text: "The team decided to use the term 'mirror'"
    })
    const open = item({
      id: 'point-open',
      text: 'Share the link so people can discuss which term should be final'
    })
    const notes = content({
      sections: [
        section({
          id: 's-terms',
          title: 'Terminology',
          keyPoints: [decided, open]
        })
      ]
    })

    const claims = collectEvidenceClaims(notes)
    expect(claims.some((claim) => claim.kind === 'sectionClaim' && claim.text.includes('mirror'))).toBe(
      true
    )
    expect(claims.some((claim) => claim.text.includes('Share the link'))).toBe(false)
    expect(claims.find((claim) => claim.kind === 'sectionClaim')?.id).toBe(
      sectionClaimId('s-terms', 'point-mirror')
    )

    const result = applyClaimVerdicts(
      notes,
      verdicts([{ id: sectionClaimId('s-terms', 'point-mirror'), verdict: 'proposed', owner: null }])
    )
    expect(result.content.sections[0]?.keyPoints).toEqual([open])
    expect(result.dropped).toBe(1)
  })

  it('drops a section when every assertive bullet is removed', () => {
    const decided = item({
      id: 'point-mirror',
      text: "The team decided to use the term 'mirror'"
    })
    const result = applyClaimVerdicts(
      content({
        sections: [section({ id: 's-terms', title: 'Terminology', keyPoints: [decided] })]
      }),
      verdicts([{ id: sectionClaimId('s-terms', 'point-mirror'), verdict: 'proposed', owner: null }])
    )
    expect(result.content.sections).toEqual([])
    expect(result.dropped).toBe(1)
  })

  it('keeps a supported section claim and keys colliding item ids per section', () => {
    const first = item({ id: 'same', text: 'The team selected option A' })
    const second = item({ id: 'same', text: 'The team selected option B' })
    const notes = content({
      sections: [
        section({ id: 's-a', title: 'Alpha', keyPoints: [first] }),
        section({ id: 's-b', title: 'Beta', keyPoints: [second] })
      ]
    })
    const claims = collectEvidenceClaims(notes)
    expect(claims.map((claim) => claim.id)).toEqual([
      sectionClaimId('s-a', 'same'),
      sectionClaimId('s-b', 'same')
    ])

    const result = applyClaimVerdicts(
      notes,
      verdicts([
        { id: sectionClaimId('s-a', 'same'), verdict: 'proposed', owner: null },
        { id: sectionClaimId('s-b', 'same'), verdict: 'supported', owner: null }
      ])
    )
    expect(result.content.sections.map((row) => row.id)).toEqual(['s-b'])
    expect(result.content.sections[0]?.keyPoints).toEqual([second])
    expect(result.dropped).toBe(1)
  })
})

describe('coverage backstop', () => {
  const release = ledger({
    text: 'Release 4.3.5 tomorrow morning',
    quote: 'release 4.3.5 tomorrow morning',
    startMs: 12_000,
    endMs: 18_000
  })

  it('treats an entry as covered when enough content tokens already appear', () => {
    expect(
      documentCoversLedgerEntry(
        release,
        'Ship plan: release 4.3.5 tomorrow morning after QA.'
      )
    ).toBe(true)
    expect(documentCoversLedgerEntry(release, 'Unrelated lunch conversation')).toBe(false)
  })

  it('appends an uncovered decision with the chunk span as the source', () => {
    const notes = content({
      sections: [
        section({
          id: 's1',
          title: 'Release planning',
          keyPoints: [item({ id: 'p1', text: 'QA is still finishing soak.' })]
        })
      ]
    })

    const result = appendUncoveredLedger(notes, [release])
    const appended = result.content.sections[0]?.supportingDetails[0]

    expect(result.appended).toBe(1)
    expect(appended?.text).toBe('Release 4.3.5 tomorrow morning')
    expect(appended?.id).toBe(detailId('Release 4.3.5 tomorrow morning'))
    expect(appended?.provenance).toBe('generated')
    expect(appended?.completed).toBe(false)
    expect(appended?.sources).toEqual([{ startMs: 12_000, endMs: 18_000 }])
  })

  it('does not duplicate a decision the document already covers', () => {
    const notes = content({
      sections: [
        section({
          id: 's1',
          title: 'Release planning',
          keyPoints: [item({ id: 'p1', text: 'Release 4.3.5 tomorrow morning after QA.' })]
        })
      ]
    })

    const result = appendUncoveredLedger(notes, [release])
    expect(result.appended).toBe(0)
    expect(result.content.sections[0]?.supportingDetails).toEqual([])
  })

  it('does not treat generic token overlap as covering a ticket entry', () => {
    const ticketEntry = ledger({
      kind: 'quantity',
      text: 'And the linear for this feature request is DD1450.',
      quote: 'And the linear for this feature request is DD1450.',
      startMs: 1_917_000,
      endMs: 1_920_000
    })
    expect(
      documentCoversLedgerEntry(
        ticketEntry,
        'The team discussed a linear feature request for background connectivity.'
      )
    ).toBe(false)
    expect(
      documentCoversLedgerEntry(ticketEntry, 'Tracked as DD-1450 for the reconnect work.')
    ).toBe(true)
  })

  it('appends ticket entries even when the cap is already exhausted', () => {
    const fillers = Array.from({ length: 8 }, (_, index) =>
      ledger({
        kind: 'decision',
        text: `alpha${index} bravo${index} charlie${index} delta${index} echo${index}`,
        quote: `alpha${index} bravo${index} charlie${index} delta${index} echo${index}`,
        startMs: index * 1_000,
        endMs: index * 1_000 + 500
      })
    )
    const ticketEntry = ledger({
      kind: 'quantity',
      text: 'And the linear for this feature request is DD1450.',
      quote: 'And the linear for this feature request is DD1450.',
      startMs: 1_917_000,
      endMs: 1_920_000
    })
    const notes = content({
      sections: [section({ id: 's1', title: 'Catch-all' })]
    })

    const result = appendUncoveredLedger(notes, [...fillers, ticketEntry])
    const texts = result.content.sections[0]?.supportingDetails.map((row) => row.text) ?? []
    expect(result.appended).toBe(9)
    expect(texts.some((text) => text.includes('DD1450'))).toBe(true)
  })

  it('enforces the append cap and prefers decisions over later kinds', () => {
    const notes = content({
      sections: [section({ id: 's1', title: 'Catch-all' })]
    })
    const decisions = [
      'Release 4.3.5 tomorrow morning',
      'Approve the Orion soak window',
      'Cancel Friday demo recording',
      'Lock analytics opt-in defaults',
      'Postpone billing migration work',
      'Adopt sequential dual source',
      'Reject the Mirror proposal',
      'Sunset the legacy reconnect path',
      'Freeze the onboarding copy deck'
    ]
    const entries = [
      ledger({ kind: 'quantity', text: 'Fourteen starts counted', quote: 'fourteen starts counted' }),
      ...decisions.map((text) => ledger({ text, quote: text.toLowerCase() }))
    ]

    const result = appendUncoveredLedger(notes, entries)
    const details = result.content.sections[0]?.supportingDetails ?? []

    expect(result.appended).toBe(8)
    expect(details).toHaveLength(8)
    expect(details.map((entry) => entry.text)).toEqual(decisions.slice(0, 8))
    expect(details.some((entry) => entry.text.includes('Fourteen'))).toBe(false)
  })

  it('appends a plausible owner onto uncovered coverage text', () => {
    const notes = content({
      sections: [section({ id: 's1', title: 'Follow-ups' })]
    })
    const result = appendUncoveredLedger(notes, [
      ledger({
        kind: 'commitment',
        text: 'File the DD1450 reconnect patch',
        owner: 'Chris',
        quote: 'file the DD1450 reconnect patch'
      })
    ])
    expect(result.content.sections[0]?.supportingDetails[0]?.text).toBe(
      'File the DD1450 reconnect patch — Chris'
    )
  })
})

describe('extractLedger retries', () => {
  it('retries once on invalid JSON and counts a second failure', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce('still not json')

    const result = await extractLedger(
      [
        {
          rows: [row({ text: 'We will ship tomorrow.', startMs: 0, endMs: 1_000 })],
          text: '[00:00] Speaker: We will ship tomorrow.',
          startMs: 0,
          endMs: 1_000
        }
      ],
      generate,
      7
    )

    expect(result.chunksFailed).toBe(1)
    expect(result.ledger).toEqual([])
    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[0]?.[0]?.seed).toBe(7)
    expect(generate.mock.calls[1]?.[0]?.seed).toBe(8)
    expect(generate.mock.calls[0]?.[0]?.prompt).toBe(
      buildLedgerPrompt('[00:00] Speaker: We will ship tomorrow.')
    )
  })
})

describe('supplementLedgerTickets', () => {
  const ticketRow = row({
    speaker: 'Chris',
    text: 'the linear for this feature request is DD1450',
    startMs: 4_000,
    endMs: 6_000
  })

  it('synthesizes a quantity entry when the LLM ledger missed the ticket', () => {
    const supplemented = supplementLedgerTickets([], [ticketRow])
    expect(supplemented).toEqual([
      {
        kind: 'quantity',
        text: 'the linear for this feature request is DD1450',
        owner: null,
        quote: 'the linear for this feature request is DD1450',
        startMs: 4_000,
        endMs: 6_000
      }
    ])
  })

  it('does not duplicate a ticket the LLM ledger already recorded', () => {
    const existing = ledger({
      kind: 'quantity',
      text: 'Opened DD-1450 for reconnect',
      quote: 'opened DD-1450 for reconnect'
    })
    expect(supplementLedgerTickets([existing], [ticketRow])).toEqual([existing])
  })
})

describe('validateNotesAgainstTranscript', () => {
  it('skips work when the transcript is empty', async () => {
    const generate = vi.fn()
    const notes = content({
      keyTakeaways: [item({ id: 'takeaway-1', text: 'Keep me' })]
    })
    const result = await validateNotesAgainstTranscript(notes, [], generate, 1)
    expect(result.stats.ran).toBe(false)
    expect(result.content).toEqual(notes)
    expect(generate).not.toHaveBeenCalled()
  })

  it('drops an unsupported takeaway using scripted generate responses', async () => {
    const notes = content({
      keyTakeaways: [item({ id: 'takeaway-mirror', text: 'Team agreed to adopt the Mirror concept' })],
      nextSteps: [
        item({
          id: 'next-review',
          title: 'Review the offline analytics PR',
          text: 'Review the offline analytics PR',
          owner: 'Norbert'
        })
      ],
      sections: [section({ id: 's1', title: 'Analytics' })]
    })
    const generate = vi.fn(async (request: { prompt: string }) => {
      if (request.prompt.includes('Extract critical outcomes')) return '[]'
      if (request.prompt.includes('Judge each claim')) {
        return JSON.stringify([
          { id: 'takeaway-mirror', verdict: 'unsupported', owner: null },
          { id: 'next-review', verdict: 'supported', owner: 'Norbert' }
        ])
      }
      throw new Error(`unexpected prompt: ${request.prompt}`)
    })

    const result = await validateNotesAgainstTranscript(
      notes,
      [row({ speaker: 'Chris', text: 'Norbert will review the offline analytics PR.', startMs: 0, endMs: 4_000 })],
      generate,
      1
    )

    expect(result.stats.ran).toBe(true)
    expect(result.content.keyTakeaways).toEqual([])
    expect(result.content.nextSteps[0]?.owner).toBe('Norbert')
    expect(result.stats.claimsChecked).toBe(2)
    expect(result.stats.claimsDropped).toBe(1)
    expect(result.stats.unvalidatedClaims).toBe(0)
    expect(collectEvidenceClaims(notes)).toHaveLength(2)
  })

  it('appends a missed transcript ticket through the coverage backstop', async () => {
    const generate = vi.fn(async (request: { prompt: string }) => {
      if (request.prompt.includes('Extract critical outcomes')) return '[]'
      if (request.prompt.includes('Judge each claim')) return '[]'
      throw new Error(`unexpected prompt: ${request.prompt}`)
    })
    const notes = content({
      sections: [
        section({
          id: 's1',
          title: 'Reconnect',
          keyPoints: [item({ id: 'p1', text: 'Reconnect still needs a Linear ticket.' })]
        })
      ]
    })

    const result = await validateNotesAgainstTranscript(
      notes,
      [
        row({
          speaker: 'Chris',
          text: 'the linear for this feature request is DD1450',
          startMs: 4_000,
          endMs: 6_000
        })
      ],
      generate,
      1
    )

    const appended = result.content.sections[0]?.supportingDetails ?? []
    expect(result.stats.ran).toBe(true)
    expect(result.stats.ledgerAppends).toBe(1)
    expect(appended[0]?.text).toContain('DD1450')
    expect(appended[0]?.sources).toEqual([{ startMs: 4_000, endMs: 6_000 }])
  })
})
