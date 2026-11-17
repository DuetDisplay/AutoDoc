import { macUsesAskAiAppendFollowups } from './mac-processing-profile'
import { logAutodocEvent } from './autodoc-log'
import { isOllamaModelLoadFailureError } from './ollama-model-load-failure'

// Hardware is sampled once, just like the stable notes hardware tier. Runtime
// pressure must never move the writer between contexts during a conversation.
const defaultAppend = macUsesAskAiAppendFollowups()
let loadFallback = false

export function useAskAiAppendFollowups(): boolean {
  if (loadFallback) return false
  const override = process.env.AUTODOC_ASK_AI_APPEND_FOLLOWUPS
  return override === undefined ? defaultAppend : override === '1'
}

export function askAiAppendContext(): number | null {
  if (!useAskAiAppendFollowups()) return null
  const override = process.env.AUTODOC_ASK_AI_APPEND_NUM_CTX
  return (override ?? (defaultAppend ? '8192' : undefined)) === '8192' ? 8192 : null
}

/** Retry a model-load failure once, then keep the original context for this session. */
export async function withAskAiWriterLoadFallback<T>(
  normalNumCtx: number,
  operation: () => Promise<T>,
  resetAppend?: () => void,
  canRetry: () => boolean = () => true
): Promise<T> {
  const expanded = askAiAppendContext() === 8192 && normalNumCtx < 8192
  try {
    return await operation()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (
      !expanded ||
      !canRetry() ||
      !(
        isOllamaModelLoadFailureError(error) ||
        /(?:failed to load|unable to load|error loading|loading model.*failed|model.*requires more.*memory|out of memory|unable to allocate|cannot allocate|llama runner process has terminated)/iu.test(
          reason
        )
      )
    )
      throw error
    loadFallback = true
    resetAppend?.()
    logAutodocEvent({
      area: 'chat',
      message: 'Ask AI append disabled for this session after writer load failure',
      context: { reason }
    })
    return operation()
  }
}
