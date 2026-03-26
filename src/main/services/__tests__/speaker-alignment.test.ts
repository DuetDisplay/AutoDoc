import { describe, it, expect } from 'vitest'
import { alignSpeakers } from '../speaker-alignment'
import type { Transcript } from '../../../shared/types'
import type { DiarizationResult } from '../diarization'

function makeTranscript(overrides: Partial<Transcript> & { startMs: number; endMs: number }): Transcript {
  return {
    id: 'test',
    meetingId: 'meeting-1',
    speaker: 'Speaker',
    text: 'test text',
    confidence: -1,
    ...overrides,
  }
}

describe('alignSpeakers', () => {
  it('assigns speaker with most overlap to each transcript segment', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
      makeTranscript({ id: 't2', startMs: 5000, endMs: 10000 }),
    ]

    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 0, end: 5.5 }] },
        { id: 'SPEAKER_01', segments: [{ start: 5.5, end: 10.0 }] },
      ],
    }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('speaker_1')
    expect(result[1].speaker).toBe('speaker_2')
  })

  it('labels segments as "me" when system audio is silent (with diarization)', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 3000 }),
      makeTranscript({ id: 't2', startMs: 3000, endMs: 6000 }),
    ]

    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_00', segments: [{ start: 3.0, end: 6.0 }] },
      ],
    }

    // System audio active only 3-6s (remote speaker), silent 0-3s (user talking)
    const systemSegments = [{ start: 3.0, end: 6.0 }]

    const result = alignSpeakers(transcripts, diarization, systemSegments)

    expect(result[0].speaker).toBe('me')
    expect(result[1].speaker).toBe('speaker_1')
  })

  it('returns transcripts unchanged when diarization is null and no mic segments', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
    ]

    const result = alignSpeakers(transcripts, null, null)

    expect(result[0].speaker).toBe('Speaker')
  })

  it('does binary split with system segments when no diarization', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 3000 }),
      makeTranscript({ id: 't2', startMs: 3000, endMs: 6000 }),
    ]

    // System audio active 0-3s means remote speaker talking then
    const systemSegments = [{ start: 0, end: 3.0 }]

    const result = alignSpeakers(transcripts, null, systemSegments)

    expect(result[0].speaker).toBe('speaker_1')
    expect(result[1].speaker).toBe('me')
  })

  it('handles empty diarization speakers', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 5000 }),
    ]

    const diarization: DiarizationResult = { speakers: [] }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('Speaker')
  })

  it('maps pyannote speaker IDs to sequential speaker_N IDs', () => {
    const transcripts: Transcript[] = [
      makeTranscript({ id: 't1', startMs: 0, endMs: 3000 }),
      makeTranscript({ id: 't2', startMs: 3000, endMs: 6000 }),
      makeTranscript({ id: 't3', startMs: 6000, endMs: 9000 }),
    ]

    const diarization: DiarizationResult = {
      speakers: [
        { id: 'SPEAKER_02', segments: [{ start: 0, end: 3.0 }] },
        { id: 'SPEAKER_00', segments: [{ start: 3.0, end: 6.0 }] },
        { id: 'SPEAKER_02', segments: [{ start: 6.0, end: 9.0 }] },
      ],
    }

    const result = alignSpeakers(transcripts, diarization, null)

    expect(result[0].speaker).toBe('speaker_1')
    expect(result[1].speaker).toBe('speaker_2')
    expect(result[2].speaker).toBe('speaker_1')
  })
})
