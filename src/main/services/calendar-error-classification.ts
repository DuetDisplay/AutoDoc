export class CalendarTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'CalendarTransientError'
    if (options && 'cause' in options) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

export class UnsupportedCalendarAccountError extends Error {
  readonly reason: 'unsupported-mailbox'

  constructor(message: string, reason: 'unsupported-mailbox' = 'unsupported-mailbox') {
    super(message)
    this.name = 'UnsupportedCalendarAccountError'
    this.reason = reason
  }
}

export class ReconnectRequiredCalendarAuthError extends Error {
  readonly reason: 'reconnect-required'

  constructor(message: string, reason: 'reconnect-required' = 'reconnect-required') {
    super(message)
    this.name = 'ReconnectRequiredCalendarAuthError'
    this.reason = reason
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return String(error)
}

export function isTransientCalendarError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()

  return [
    'enotfound',
    'err_name_not_resolved',
    'err_network_io_suspended',
    'eai_again',
    'econnreset',
    'etimedout',
    'fetch failed',
    'network error',
    'networkerror',
    'timeout',
    'temporarily unavailable',
    'service unavailable'
  ].some((pattern) => message.includes(pattern))
  || /\b(408|425|429|500|502|503|504)\b/.test(message)
}

export function isUnsupportedMicrosoftMailboxError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()
  return message.includes('mailboxnotenabledforrestapi')
}

export function isReconnectRequiredMicrosoftAuthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase()

  return [
    'invalid_client',
    'invalid_grant',
    'interaction_required',
    'insufficient scopes',
    'insufficient scope',
    'insufficient privileges',
    'insufficient privileges to complete the operation',
    'token is expired',
    'access token has expired',
    'invalidauthenticationtoken',
    'error_access_denied'
  ].some((pattern) => message.includes(pattern))
}

export function isUnsupportedCalendarAccountError(
  error: unknown
): error is UnsupportedCalendarAccountError {
  return error instanceof UnsupportedCalendarAccountError
}

export function isReconnectRequiredCalendarAuthError(
  error: unknown
): error is ReconnectRequiredCalendarAuthError {
  return error instanceof ReconnectRequiredCalendarAuthError
}

export function isCalendarTransientError(error: unknown): error is CalendarTransientError {
  return error instanceof CalendarTransientError
}
