const TRANSIENT_MESSAGE_PARTS = [
  'enotfound',
  'err_name_not_resolved',
  'err_network_io_suspended',
  'err_network_changed',
  'err_internet_disconnected',
  'err_connection_',
  'eai_again',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'fetch failed',
  'socket hang up',
  'network socket disconnected',
  'network error',
  'networkerror',
  'terminated',
  'timeout',
  'temporarily unavailable',
  'service unavailable'
]

/** A dropped connection or a server hiccup: not ours to fix, and usually gone on the next try. */
export function isTransientNetworkError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    TRANSIENT_MESSAGE_PARTS.some((part) => message.includes(part)) ||
    /\b(408|425|429|500|502|503|504)\b/.test(message)
  )
}
