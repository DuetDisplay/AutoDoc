export const OLLAMA_MODEL_LOAD_FAILED_ERROR_CODE = 'OLLAMA_MODEL_LOAD_FAILED'

// llama.cpp raises "failed to load model from <path>" only when the model file cannot be
// opened or parsed. Bare "llama_model_loader" lines are printed on every successful load, and
// "error loading model" alone also covers GPU allocation failures that recovery can fix.
const MODEL_LOAD_FAILURE_PATTERN = /failed to load model from/i
const INSUFFICIENT_MEMORY_PATTERN = /requires more system memory/i

/**
 * True when Ollama could not open or parse the model file. Restarting the serve
 * cannot fix this (for example the runner received a models path it cannot open),
 * so it is never a transient runtime error. Memory shortfalls are a different,
 * recoverable class and are excluded.
 */
export function isOllamaModelLoadFailureText(text: string): boolean {
  return MODEL_LOAD_FAILURE_PATTERN.test(text) && !INSUFFICIENT_MEMORY_PATTERN.test(text)
}

export function createOllamaModelLoadFailedError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: OLLAMA_MODEL_LOAD_FAILED_ERROR_CODE })
}

export function isOllamaModelLoadFailureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code === OLLAMA_MODEL_LOAD_FAILED_ERROR_CODE) return true
  return isOllamaModelLoadFailureText(error.message)
}
