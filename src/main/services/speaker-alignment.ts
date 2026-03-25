import type { Transcript } from '../../shared/types'
import type { DiarizationResult } from './diarization'

interface TimeSegment {
  start: number
  end: number
}

function overlap(aStartMs: number, aEndMs: number, bStartSec: number, bEndSec: number): number {
  const aStartSec = aStartMs / 1000
  const aEndSec = aEndMs / 1000
  const overlapStart = Math.max(aStartSec, bStartSec)
  const overlapEnd = Math.min(aEndSec, bEndSec)
  return Math.max(0, overlapEnd - overlapStart)
}

export function alignSpeakers(
  transcripts: Transcript[],
  diarization: DiarizationResult | null,
  micSegments: TimeSegment[] | null,
): Transcript[] {
  // Two-stream only (no ML diarization): label by mic activity
  if ((!diarization || diarization.speakers.length === 0) && micSegments) {
    return transcripts.map((t) => {
      let micOverlap = 0
      for (const mic of micSegments) {
        micOverlap += overlap(t.startMs, t.endMs, mic.start, mic.end)
      }
      return { ...t, speaker: micOverlap > 0 ? 'me' : 'speaker_1' }
    })
  }

  if (!diarization || diarization.speakers.length === 0) {
    return transcripts
  }

  const diarSegments: { pyId: string; start: number; end: number }[] = []
  for (const speaker of diarization.speakers) {
    for (const seg of speaker.segments) {
      diarSegments.push({ pyId: speaker.id, start: seg.start, end: seg.end })
    }
  }

  const pyIdToSpeakerId = new Map<string, string>()
  let nextSpeakerNum = 1

  return transcripts.map((t) => {
    if (micSegments) {
      let micOverlap = 0
      for (const mic of micSegments) {
        micOverlap += overlap(t.startMs, t.endMs, mic.start, mic.end)
      }
      let systemOverlap = 0
      for (const seg of diarSegments) {
        systemOverlap += overlap(t.startMs, t.endMs, seg.start, seg.end)
      }
      if (micOverlap >= systemOverlap && micOverlap > 0) {
        return { ...t, speaker: 'me' }
      }
    }

    let bestPyId: string | null = null
    let bestOverlap = 0
    for (const seg of diarSegments) {
      const ov = overlap(t.startMs, t.endMs, seg.start, seg.end)
      if (ov > bestOverlap) {
        bestOverlap = ov
        bestPyId = seg.pyId
      }
    }

    if (!bestPyId) {
      return t
    }

    if (!pyIdToSpeakerId.has(bestPyId)) {
      pyIdToSpeakerId.set(bestPyId, `speaker_${nextSpeakerNum++}`)
    }

    return { ...t, speaker: pyIdToSpeakerId.get(bestPyId)! }
  })
}
