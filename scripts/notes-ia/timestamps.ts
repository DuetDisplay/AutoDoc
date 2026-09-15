import type { SourceRange } from './types.ts'

/** Quiet timestamp suffix, minutes may exceed 59 for long meetings. */
export function formatTimestamp(startMs: number): string {
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new Error('Timestamp requires a finite non-negative millisecond offset.')
  }
  const totalSeconds = Math.floor(startMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`
}

export function formatSourceSuffix(ranges: readonly SourceRange[]): string {
  if (ranges.length === 0) return ''
  const earliest = [...ranges].sort((left, right) => left.startMs - right.startMs)[0]
  const stamp = formatTimestamp(earliest.startMs)
  if (ranges.length === 1) return stamp
  return `${stamp} · ${ranges.length} sources`
}

export function rangeKey(range: SourceRange): string {
  return `${range.startMs}:${range.endMs}`
}
