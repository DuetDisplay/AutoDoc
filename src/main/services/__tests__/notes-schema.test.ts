import { describe, expect, it } from 'vitest'
import type { MeetingNotesContent, MeetingNotesV2 } from '../../../shared/types'
import { NotesSchemaError, parseMeetingNotesContent, parseMeetingNotesV2 } from '../notes-schema'
import {
  computeNotesAttributionRevision,
  computeNotesRevision,
  computeTranscriptRevision
} from '../notes-revision'

const sourceTranscriptRevision = computeTranscriptRevision('meeting-1', [{ id: 'row-1' }])
const sourceAttributionRevision = computeNotesAttributionRevision('meeting-1', [
  { id: 'row-1', confirmedSpeakerLabel: 'Chris' }
])

function createContent(): MeetingNotesContent {
  return {
    overview: {
      text: 'Overview',
      provenance: 'generated',
      sources: [
        { startMs: 3_000, endMs: 4_000 },
        { startMs: 0, endMs: 0 },
        { startMs: 3_000, endMs: 4_000 },
        { startMs: 2_000, endMs: 3_000 },
        { startMs: 2_500, endMs: 3_500 }
      ]
    },
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: []
  }
}

function createNotes(meetingId = 'meeting-1'): MeetingNotesV2 {
  const content = createContent()
  return {
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision,
    sourceAttributionRevision,
    revision: computeNotesRevision(
      meetingId,
      sourceTranscriptRevision,
      sourceAttributionRevision,
      content
    ),
    ...content
  }
}

describe('notes schema', () => {
  it('snapshots canonical multi-range evidence without losing 0ms, adjacent, or overlapping sources', () => {
    const parsed = parseMeetingNotesV2(createNotes(), 'meeting-1')

    expect(parsed.overview?.sources).toEqual([
      { startMs: 0, endMs: 0 },
      { startMs: 2_000, endMs: 3_000 },
      { startMs: 2_500, endMs: 3_500 },
      { startMs: 3_000, endMs: 4_000 }
    ])
    expect(parsed.sourceTranscriptRevision).toBe(sourceTranscriptRevision)
  })

  it('requires V2 source binding and persisted provenance', () => {
    const noTranscriptBinding = { ...createNotes() }
    delete (noTranscriptBinding as Partial<MeetingNotesV2>).sourceTranscriptRevision
    expect(() => parseMeetingNotesV2(noTranscriptBinding)).toThrow(NotesSchemaError)

    const noAttributionBinding = { ...createNotes() }
    delete (noAttributionBinding as Partial<MeetingNotesV2>).sourceAttributionRevision
    expect(() => parseMeetingNotesV2(noAttributionBinding)).toThrow(NotesSchemaError)

    const legacyProvenance = createNotes()
    ;(legacyProvenance.overview as { provenance: string }).provenance = 'legacy'
    expect(() => parseMeetingNotesV2(legacyProvenance)).toThrow(NotesSchemaError)
  })

  it('requires evidence for every generated semantic block', () => {
    const item = {
      id: 'item-1',
      title: null,
      topic: null,
      owner: null,
      deadline: null,
      text: 'Generated item',
      sources: [],
      provenance: 'generated' as const
    }

    expect(() =>
      parseMeetingNotesContent({
        overview: { text: 'Generated overview', sources: [], provenance: 'generated' },
        keyTakeaways: [],
        sections: [],
        decisions: [],
        nextSteps: []
      })
    ).toThrow(NotesSchemaError)
    expect(() =>
      parseMeetingNotesContent({
        overview: null,
        keyTakeaways: [],
        sections: [
          {
            id: 'section-1',
            title: 'Section',
            summary: { text: 'Generated summary', sources: [], provenance: 'generated' },
            keyPoints: [],
            supportingDetails: []
          }
        ],
        decisions: [],
        nextSteps: []
      })
    ).toThrow(NotesSchemaError)
    expect(() =>
      parseMeetingNotesContent({
        overview: null,
        keyTakeaways: [item],
        sections: [],
        decisions: [],
        nextSteps: []
      })
    ).toThrow(NotesSchemaError)
  })

  it('allows source-less user-created and user-edited blocks', () => {
    expect(
      parseMeetingNotesContent({
        overview: { text: 'Created overview', sources: [], provenance: 'user-created' },
        keyTakeaways: [
          {
            id: 'edited-item',
            title: null,
            topic: null,
            owner: null,
            deadline: null,
            text: 'Edited item',
            sources: [],
            provenance: 'user-edited'
          }
        ],
        sections: [],
        decisions: [],
        nextSteps: []
      })
    ).toMatchObject({
      overview: { sources: [], provenance: 'user-created' },
      keyTakeaways: [{ sources: [], provenance: 'user-edited' }]
    })
  })

  it.each([
    { startMs: -1, endMs: 2 },
    { startMs: 3, endMs: 2 },
    { startMs: Number.NaN, endMs: 2 },
    { startMs: 1, endMs: Number.POSITIVE_INFINITY }
  ])('rejects invalid V2 source ranges: $startMs → $endMs', (range) => {
    const notes = createNotes()
    notes.overview!.sources = [range]
    expect(() => parseMeetingNotesV2(notes)).toThrow(NotesSchemaError)
  })

  it('rejects unknown fields, duplicate IDs, and revision tampering', () => {
    expect(() => parseMeetingNotesV2({ ...createNotes(), privatePrompt: 'no' })).toThrow(
      NotesSchemaError
    )

    const duplicate: MeetingNotesContent = {
      overview: null,
      keyTakeaways: [
        {
          id: 'same',
          title: null,
          topic: null,
          owner: null,
          deadline: null,
          text: 'First',
          sources: [],
          provenance: 'generated'
        }
      ],
      sections: [
        {
          id: 'same',
          title: 'Duplicate',
          summary: null,
          keyPoints: [],
          supportingDetails: []
        }
      ],
      decisions: [],
      nextSteps: []
    }
    expect(() => parseMeetingNotesContent(duplicate)).toThrow(NotesSchemaError)

    const tampered = createNotes()
    tampered.overview!.text = 'changed after hashing'
    expect(() => parseMeetingNotesV2(tampered)).toThrowError(
      expect.objectContaining({ code: 'revision-mismatch' })
    )
  })
})
