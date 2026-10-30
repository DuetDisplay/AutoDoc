/** An Error that tells captureError which Sentry fingerprint to group it under. */
export type FingerprintedError = Error & { sentryFingerprint?: string[] }

export function withSentryFingerprint<T extends Error>(error: T, fingerprint: string[]): T {
  ;(error as FingerprintedError).sentryFingerprint = fingerprint
  return error
}

/** Error for an ffmpeg child process that ended without success; groups by step and exit code. */
export function createFfmpegExitError(
  step: string,
  exitCode: number | null,
  message: string
): Error {
  return withSentryFingerprint(new Error(message), ['ffmpeg-exit', step, String(exitCode)])
}
