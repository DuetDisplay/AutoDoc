export function isMissingOllamaModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Ollama returned 404:/i.test(message) && /model\b.*\bnot found/i.test(message)
}

export function notesModelSetupError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('Ollama notes model setup failed:'))
    return error
  return new Error(
    `Ollama notes model setup failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  )
}
