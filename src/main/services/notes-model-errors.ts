import { withSentryFingerprint } from './sentry-fingerprint'

export function isMissingOllamaModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Ollama returned 404:/i.test(message) && /model\b.*\bnot found/i.test(message)
}

export function notesModelSetupError(error: unknown): Error {
  const setupError =
    error instanceof Error && error.message.startsWith('Ollama notes model setup failed:')
      ? error
      : new Error(
          `Ollama notes model setup failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
  return withSentryFingerprint(setupError, ['ollama-notes-model-setup'])
}

const OLLAMA_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
])

/** True when the error means the Ollama serve could not be reached (dead or restarting). */
export function isOllamaConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error instanceof TypeError && error.message === 'fetch failed') return true
  const codeOf = (value: unknown): unknown =>
    value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined
  const codes = [codeOf(error), codeOf(error.cause)]
  return codes.some((code) => typeof code === 'string' && OLLAMA_CONNECTION_ERROR_CODES.has(code))
}
