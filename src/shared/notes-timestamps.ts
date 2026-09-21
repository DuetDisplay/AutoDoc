import type { NoteSourceRange } from './types'

export function isMeetingSpanOnly(
  sources: readonly NoteSourceRange[],
  meetingSpan: readonly NoteSourceRange[]
): boolean {
  if (sources.length === 0 || meetingSpan.length === 0) return true
  if (sources.length !== 1 || meetingSpan.length !== 1) return false
  return sources[0].startMs === meetingSpan[0].startMs && sources[0].endMs === meetingSpan[0].endMs
}
