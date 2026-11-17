import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { withSentryFingerprint, type FingerprintedError } from './sentry-fingerprint'

const MESSAGE = 'Failed to start managed Ollama server'

/** Sends one report for a failed setup, with a title that says what failed. */
export function reportOllamaSetupFailure(error: unknown, failedStep = 'starting'): void {
  const reason = error instanceof Error ? error.message : String(error)
  const fingerprint = (error as FingerprintedError | null)?.sentryFingerprint

  // The exit was already reported, with the server's output, when the process ended.
  if (fingerprint?.[0] === 'ollama-server-exited') {
    logAutodocEvent({ area: 'ollama', level: 'warn', message: MESSAGE, context: { reason } })
    return
  }

  logAutodocFailure({
    area: 'ollama',
    message: MESSAGE,
    error: withSentryFingerprint(
      new Error(`Ollama setup failed while ${failedStep}`, { cause: error }),
      fingerprint ?? ['ollama-setup-failed', failedStep]
    ),
    context: { reason }
  })
}
