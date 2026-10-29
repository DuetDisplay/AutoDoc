const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT'])
const DISK_FULL_MESSAGE_PATTERN =
  /no space left on device|not enough space on the disk|disk quota exceeded|\bENOSPC\b|\bEDQUOT\b/i
const MAX_CAUSE_DEPTH = 4

/**
 * True when an error (or error text, e.g. ffmpeg/ditto stderr) means the disk is full.
 * Matches Node's ENOSPC/EDQUOT codes and the common OS message wording, and follows
 * `cause` chains so wrapped errors still count.
 */
export function isDiskFullError(err: unknown, depth = 0): boolean {
  if (err == null) return false
  if (typeof err === 'string') return DISK_FULL_MESSAGE_PATTERN.test(err)
  if (typeof err !== 'object') return false

  const candidate = err as { code?: unknown; message?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string' && DISK_FULL_CODES.has(candidate.code)) return true
  if (typeof candidate.message === 'string' && DISK_FULL_MESSAGE_PATTERN.test(candidate.message)) {
    return true
  }
  if (candidate.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    return isDiskFullError(candidate.cause, depth + 1)
  }
  return false
}
