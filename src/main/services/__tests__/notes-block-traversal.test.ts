import { describe, expect, it } from 'vitest'
import type { NormalizedNotes } from '../../../shared/types'
import {
  computeLegacyNotesRevision,
  computeNotesAttributionRevision,
  computeTranscriptRevision
} from '../notes-revision'
import { traverseNormalizedNotes } from '../notes-block-traversal'

const currentTranscriptRevision = computeTranscriptRevision('meeting-1', [{ id: 'row-1' }])
const currentAttributionRevision = computeNotesAttributionRevision('meeting-1', [
  { id: 'row-1', confirmedSpeakerLabel: 'Chris' }
])

function createNotes(): NormalizedNotes {
  return {
    normalizedSchemaVersion: 1,
    meetingId: 'meeting-1',
    source: { format: 'notes-v2', schemaVersion: 2 },
    sourceTranscriptRevision: currentTranscriptRevision,
    sourceAttributionRevision: currentAttributionRevision,
    revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    overview: {
      text: 'Overview',
      sources: [{ startMs: 0, endMs: 0 }],
      provenance: 'generated'
    },
    keyTakeaways: [
      {
        id: 'takeaway',
        title: 'Takeaway',
        topic: 'Project',
        owner: null,
        deadline: null,
        text: 'Key result',
        sources: [
          { startMs: 10, endMs: 20 },
          { startMs: 30, endMs: 40 },
          { startMs: 50, endMs: 60 }
        ],
        provenance: 'user-edited',
        legacySource: null
      }
    ],
    sections: [
      {
        id: 'section-1',
        title: 'Implementation',
        summary: {
          text: 'Summary',
          sources: [{ startMs: 55, endMs: 60 }],
          provenance: 'generated'
        },
        keyPoints: [
          {
            id: 'point-1',
            title: null,
            topic: 'Implementation',
            owner: null,
            deadline: null,
            text: 'Point',
            sources: [{ startMs: 60, endMs: 70 }],
            provenance: 'generated',
            legacySource: null
          }
        ],
        supportingDetails: [
          {
            id: 'detail-1',
            title: null,
            topic: null,
            owner: null,
            deadline: null,
            text: 'Detail',
            sources: [{ startMs: 70, endMs: 80 }],
            provenance: 'generated',
            legacySource: null
          }
        ]
      }
    ],
    decisions: [],
    nextSteps: [
      {
        id: 'step-1',
        title: null,
        topic: null,
        owner: 'Casey',
        deadline: 'Friday',
        text: 'Ship it',
        sources: [{ startMs: 90, endMs: 100 }],
        provenance: 'generated',
        legacySource: null
      }
    ]
  }
}

describe('normalized notes traversal', () => {
  it('projects every semantic layer with stable references and complete, copied source arrays', () => {
    const notes = createNotes()
    const blocks = traverseNormalizedNotes(
      notes,
      currentTranscriptRevision,
      currentAttributionRevision
    )

    expect(blocks.map((block) => block.location)).toEqual([
      'overview',
      'key-takeaway',
      'section-summary',
      'key-point',
      'supporting-detail',
      'next-step'
    ])
    expect(blocks.map((block) => block.ref)).toEqual([
      { kind: 'overview' },
      { kind: 'item', itemId: 'takeaway' },
      { kind: 'section-summary', sectionId: 'section-1' },
      { kind: 'item', itemId: 'point-1' },
      { kind: 'item', itemId: 'detail-1' },
      { kind: 'item', itemId: 'step-1' }
    ])
    expect(blocks[1]).toMatchObject({
      topic: 'Project',
      provenance: 'user-edited',
      evidenceStatus: 'current'
    })
    expect(blocks[1].sources).toEqual(notes.keyTakeaways[0].sources)
    expect(blocks[1].sources).not.toBe(notes.keyTakeaways[0].sources)
    expect(blocks[3]).toMatchObject({ sectionId: 'section-1', sectionTitle: 'Implementation' })
  })

  it('marks a V2 document stale when its transcript binding changes', () => {
    const staleTranscriptRevision = computeTranscriptRevision('meeting-1', [
      { id: 'replacement-row' }
    ])
    expect(
      traverseNormalizedNotes(
        createNotes(),
        staleTranscriptRevision,
        currentAttributionRevision
      ).every((block) => block.evidenceStatus === 'stale')
    ).toBe(true)
  })

  it('marks a V2 document stale when confirmed speaker attribution changes', () => {
    const relabeled = computeNotesAttributionRevision('meeting-1', [
      { id: 'row-1', confirmedSpeakerLabel: 'Taylor' }
    ])
    expect(
      traverseNormalizedNotes(createNotes(), currentTranscriptRevision, relabeled).every(
        (block) => block.evidenceStatus === 'stale'
      )
    ).toBe(true)
  })

  it('does not claim evidence is current when the current transcript revision is unavailable', () => {
    expect(
      traverseNormalizedNotes(createNotes(), null, currentAttributionRevision).every(
        (block) => block.evidenceStatus === 'unknown'
      )
    ).toBe(true)
    expect(
      traverseNormalizedNotes(createNotes(), currentTranscriptRevision, null).every(
        (block) => block.evidenceStatus === 'unknown'
      )
    ).toBe(true)
  })

  it('marks legacy projections unknown without inventing a transcript binding', () => {
    const notes: NormalizedNotes = {
      ...createNotes(),
      source: { format: 'legacy-segments', adapterVersion: 1 },
      sourceTranscriptRevision: null,
      sourceAttributionRevision: null,
      revision: computeLegacyNotesRevision('meeting-1', { legacy: true })
    }
    notes.keyTakeaways[0].provenance = 'legacy'
    notes.keyTakeaways[0].legacySource = {
      adapterVersion: 1,
      bucket: 'information',
      itemIndex: 0,
      segmentId: 'legacy-id',
      meetingId: 'meeting-1',
      category: 'information',
      topic: 'Project',
      sourceStartMs: 10,
      sourceEndMs: 20
    }

    const blocks = traverseNormalizedNotes(
      notes,
      currentTranscriptRevision,
      currentAttributionRevision
    )
    expect(blocks.every((block) => block.evidenceStatus === 'unknown')).toBe(true)
    expect(blocks[0].sourceTranscriptRevision).toBeNull()
    expect(blocks[0].sourceAttributionRevision).toBeNull()
    expect(blocks[1].legacySource).toEqual(notes.keyTakeaways[0].legacySource)
    expect(blocks[1].legacySource).not.toBe(notes.keyTakeaways[0].legacySource)
  })
})
