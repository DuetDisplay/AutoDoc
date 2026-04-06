import { describe, it, expect } from 'vitest'
import {
  filterLowSignalHallucinations,
  hasUsableTranscriptContent,
  summarizeSpeechSignal,
} from '../transcript-guardrails'
import type { Transcript } from '../../../shared/types'

function makeTranscript(text: string, index = 0): Transcript {
  return {
    id: `meeting-1-${index}`,
    meetingId: 'meeting-1',
    speaker: 'Speaker',
    text,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    confidence: -1,
  }
}

describe('transcript guardrails', () => {
  it('treats silent recordings as likely silent', () => {
    const summary = summarizeSpeechSignal([], 45)

    expect(summary.likelySilent).toBe(true)
    expect(summary.lowSignal).toBe(true)
  })

  it('drops common whisper boilerplate on low-signal audio', () => {
    const signal = summarizeSpeechSignal([{ start: 0, end: 0.2 }], 60)

    const filtered = filterLowSignalHallucinations([
      makeTranscript('Subtitles by the Amara.org community', 0),
      makeTranscript('Thank you.', 1),
    ], signal)

    expect(filtered).toEqual([])
  })

  it('recognizes substantive transcript content', () => {
    expect(hasUsableTranscriptContent([
      makeTranscript('Windows rewrite rollout stays at 30 percent while 70 percent remains on legacy.', 0),
    ])).toBe(true)
  })

  it('rejects transcript-only boilerplate as unusable', () => {
    expect(hasUsableTranscriptContent([
      makeTranscript('Subtitles by the Amara.org community', 0),
      makeTranscript('Thank you.', 1),
    ])).toBe(false)
  })
})
