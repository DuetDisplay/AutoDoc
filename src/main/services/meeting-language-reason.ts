import type { MeetingLanguageReasonCode } from '../../shared/meeting-language'
import { isDiskFullError } from './disk-full'

const RUNTIME_MISSING_PATTERN = /speech runtime is missing/i
const VERIFICATION_PATTERN = /SHA256|unexpected size/i
const DOWNLOAD_PATTERN =
  /Failed to download|fetch failed|failed to fetch|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|UND_ERR_|socket hang up|network error|offline|timed out|aborted/i

/**
 * Maps a Mac meeting-language setup failure to a small set of causes the UI can
 * explain in every language. Anything unrecognized becomes `setup-failed`; the
 * original English message stays in the engine state's `reason` for logs.
 */
export function classifyMacLanguageSetupError(error: unknown): MeetingLanguageReasonCode {
  if (isDiskFullError(error)) return 'setup-disk-full'
  const message = error instanceof Error ? error.message : String(error)
  if (RUNTIME_MISSING_PATTERN.test(message)) return 'speech-runtime-missing'
  if (VERIFICATION_PATTERN.test(message)) return 'setup-verification-failed'
  if (DOWNLOAD_PATTERN.test(message)) return 'setup-download-failed'
  return 'setup-failed'
}
