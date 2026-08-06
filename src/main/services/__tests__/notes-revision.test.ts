import { describe, expect, it } from 'vitest'
import type { MeetingNotesContent } from '../../../shared/types'
import {
  canonicalStringify,
  computeNotesAttributionRevision,
  computeNotesRevision,
  computeTranscriptRevision,
  normalizeNoteSources,
  NotesCanonicalizationError
} from '../notes-revision'

const transcriptRevision = computeTranscriptRevision('meeting-a', [{ id: 'row-1', text: 'Hello' }])
const attributionRevision = computeNotesAttributionRevision('meeting-a', [
  { id: 'row-1', confirmedSpeakerLabel: 'Chris' }
])

function createContent(text = ' Detailed note '): MeetingNotesContent {
  return {
    overview: {
      text,
      sources: [{ startMs: 20, endMs: 30 }],
      provenance: 'generated'
    },
    keyTakeaways: [],
    sections: [],
    decisions: [],
    nextSteps: []
  }
}

describe('notes revisions', () => {
  it('canonicalizes object keys while preserving array order and exact strings', () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(canonicalStringify(['a', 'b'])).not.toBe(canonicalStringify(['b', 'a']))
    expect(canonicalStringify(' text ')).not.toBe(canonicalStringify('text'))
  })

  it('normalizes only exact duplicate source ranges', () => {
    expect(
      normalizeNoteSources([
        { startMs: 20, endMs: 30 },
        { startMs: 0, endMs: 0 },
        { startMs: 10, endMs: 20 },
        { startMs: 10, endMs: 15 },
        { startMs: 20, endMs: 30 }
      ])
    ).toEqual([
      { startMs: 0, endMs: 0 },
      { startMs: 10, endMs: 15 },
      { startMs: 10, endMs: 20 },
      { startMs: 20, endMs: 30 }
    ])
  })

  it('binds notes revisions to source transcript and durable provenance', () => {
    const content = createContent()
    const first = computeNotesRevision(
      'meeting-a',
      transcriptRevision,
      attributionRevision,
      content
    )
    const equivalent = computeNotesRevision('meeting-a', transcriptRevision, attributionRevision, {
      ...content,
      overview: {
        ...content.overview!,
        sources: [
          { startMs: 20, endMs: 30 },
          { startMs: 20, endMs: 30 }
        ]
      }
    })

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(equivalent).toBe(first)
    expect(
      computeNotesRevision('meeting-b', transcriptRevision, attributionRevision, content)
    ).not.toBe(first)
    expect(
      computeNotesRevision(
        'meeting-a',
        computeTranscriptRevision('meeting-a', [{ id: 'row-1', text: 'Changed' }]),
        attributionRevision,
        content
      )
    ).not.toBe(first)
    expect(
      computeNotesRevision('meeting-a', transcriptRevision, attributionRevision, {
        ...content,
        overview: { ...content.overview!, provenance: 'user-edited' }
      })
    ).not.toBe(first)
    expect(
      computeNotesRevision(
        'meeting-a',
        transcriptRevision,
        computeNotesAttributionRevision('meeting-a', [
          { id: 'row-1', confirmedSpeakerLabel: 'Taylor' }
        ]),
        content
      )
    ).not.toBe(first)
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, BigInt(1), new Date(0)])(
    'rejects non-canonical values: %s',
    (value) => {
      expect(() => canonicalStringify(value)).toThrow(NotesCanonicalizationError)
    }
  )
})
