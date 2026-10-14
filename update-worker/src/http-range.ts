/** Single HTTP byte ranges, including suffix/open-ended ranges used by updaters. */
export function rangeFor(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) }
  }
  const offset = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset)
    return null
  return { offset, length: end - offset + 1 }
}
