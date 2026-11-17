/** Intentional scheduling cancellation is not a failed model or optional-pass miss. */
export function throwIfNotesPreempted(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'SEGMENTATION_PREEMPTED') throw error instanceof Error ? error : new Error(message)
}
