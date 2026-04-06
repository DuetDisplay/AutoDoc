import type { Transcript } from '../../shared/types'

export interface SpeechSignalSummary {
  totalSpeechMs: number
  speechRatio: number
  likelySilent: boolean
  lowSignal: boolean
}

const LOW_SIGNAL_PATTERNS = [
  /\bsubtitles by (the )?amara\.org community\b/i,
  /\bamara\.org community\b/i,
  /^\s*thank you\.?\s*$/i,
  /^\s*thanks\.?\s*$/i,
  /^\s*thanks everyone\.?\s*$/i,
  /^\s*thanks everybody\.?\s*$/i,
]

const MIN_MEANINGFUL_SPEECH_MS = 400
const LOW_SIGNAL_SPEECH_MS = 1_500
const LOW_SIGNAL_RATIO = 0.005

function countAlphaWords(text: string): number {
  const matches = text.match(/[a-z]{2,}/gi)
  return matches?.length ?? 0
}

export function summarizeSpeechSignal(
  activeSegments: Array<{ start: number; end: number }>,
  audioDurationSec?: number,
): SpeechSignalSummary {
  const totalSpeechMs = Math.round(
    activeSegments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start) * 1000, 0),
  )
  const durationMs = audioDurationSec ? Math.max(1, Math.round(audioDurationSec * 1000)) : 0
  const speechRatio = durationMs > 0 ? totalSpeechMs / durationMs : 0

  return {
    totalSpeechMs,
    speechRatio,
    likelySilent: totalSpeechMs < MIN_MEANINGFUL_SPEECH_MS && (durationMs === 0 || speechRatio < LOW_SIGNAL_RATIO),
    lowSignal: totalSpeechMs < LOW_SIGNAL_SPEECH_MS && (durationMs === 0 || speechRatio < LOW_SIGNAL_RATIO),
  }
}

export function isKnownLowSignalPhrase(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function filterLowSignalHallucinations(
  transcripts: Transcript[],
  signal: SpeechSignalSummary,
): Transcript[] {
  if (transcripts.length === 0) return transcripts

  const filtered = signal.likelySilent
    ? transcripts.filter((segment) => !isKnownLowSignalPhrase(segment.text))
    : transcripts.slice()

  if (filtered.length === 0) return filtered

  if (!signal.likelySilent) return filtered

  const hasMeaningfulContent = filtered.some((segment) => countAlphaWords(segment.text) >= 4)
  return hasMeaningfulContent ? filtered : []
}

export function hasUsableTranscriptContent(transcripts: Transcript[]): boolean {
  const nonEmpty = transcripts
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)

  if (nonEmpty.length === 0) return false
  if (nonEmpty.every((text) => isKnownLowSignalPhrase(text))) return false

  const meaningful = nonEmpty.filter((text) => !isKnownLowSignalPhrase(text))
  if (meaningful.length === 0) return false

  const totalAlphaWords = meaningful.reduce((sum, text) => sum + countAlphaWords(text), 0)
  return totalAlphaWords >= 4
}
