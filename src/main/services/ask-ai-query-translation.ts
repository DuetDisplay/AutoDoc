import type { IndexedMeeting } from './meeting-index'
import type { AskAiConversationTurn } from './ask-ai-conversation'
import { detectChatQuestionLanguage, resolveChatReplyLanguage } from './chat-reply-language'
import { MEETING_LANGUAGE_DEFINITIONS, isMeetingLanguageCode } from '../../shared/meeting-language'
import { logAutodocEvent } from './autodoc-log'
import { useAskAiQueryTranslation } from './ask-ai-top-match'

export interface AskAiQueryTranslation {
  language: string
  text: string
}

/** Unknown stays unknown; use the existing question/reply-language resolution only. */
export function askAiTranslationTargets(
  question: string,
  history: AskAiConversationTurn[],
  meetings: IndexedMeeting[]
): string[] {
  const known =
    detectChatQuestionLanguage(question) ??
    [...history]
      .reverse()
      .filter((turn) => turn.role === 'user')
      .map((turn) => detectChatQuestionLanguage(turn.content))
      .find(Boolean)
  if (!known) return []
  const language = resolveChatReplyLanguage(question, history, known)
  const counts = new Map<string, number>()
  for (const meeting of meetings) {
    const other = meeting.meetingLanguage
    if (isMeetingLanguageCode(other) && other !== language)
      counts.set(other, (counts.get(other) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .slice(0, 6)
    .map(([code]) => code)
}

/** One ephemeral call to the already warmed writer; no translated text leaves retrieval. */
export class AskAiQueryTranslator {
  private active = new Set<AbortController>()
  constructor(
    private options: {
      baseUrl: () => string
      model: () => string
      numCtx: () => number
      canInfer: () => boolean
      isReady: () => boolean
      waitReady: (signal: AbortSignal) => Promise<void>
    }
  ) {}

  cancelActive(): void {
    for (const controller of this.active) controller.abort()
  }

  async translate(
    question: string,
    targets: string[],
    signal?: AbortSignal
  ): Promise<AskAiQueryTranslation[]> {
    if (
      !useAskAiQueryTranslation() ||
      !targets.length ||
      !this.options.canInfer() ||
      !this.options.isReady() ||
      signal?.aborted
    )
      return []
    const started = performance.now(),
      controller = new AbortController()
    let outcome = 'error'
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.active.add(controller)
    const timeout = setTimeout(() => {
      outcome = 'timeout'
      controller.abort()
    }, 3000)
    try {
      await this.options.waitReady(controller.signal)
      if (!this.options.canInfer() || !this.options.isReady()) {
        outcome = 'busy'
        return []
      }
      controller.signal.throwIfAborted()
      const labels = targets
        .map(
          (code) =>
            `${code}: ${MEETING_LANGUAGE_DEFINITIONS.find((language) => language.code === code)?.label ?? code}`
        )
        .join(', ')
      const response = await fetch(`${this.options.baseUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model(),
          stream: false,
          keep_alive: '10m',
          messages: [
            {
              role: 'system',
              content: `Translate the user's question into each requested language. Do not answer it. Preserve names, quoted meeting titles, numbers and references. Return only a JSON object with exactly these language-code keys and translated strings: ${labels}.`
            },
            { role: 'user', content: question }
          ],
          format: {
            type: 'object',
            properties: Object.fromEntries(targets.map((code) => [code, { type: 'string' }])),
            required: targets,
            additionalProperties: false
          },
          options: { temperature: 0, num_predict: 220, num_ctx: this.options.numCtx() }
        })
      })
      if (!response.ok) return []
      const body = (await response.json()) as { message?: { content?: unknown } }
      let value: unknown
      try {
        value = typeof body.message?.content === 'string' ? JSON.parse(body.message.content) : null
      } catch {
        value = null
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== targets.length ||
        targets.some(
          (code) =>
            typeof (value as Record<string, unknown>)[code] !== 'string' ||
            !(value as Record<string, string>)[code].trim()
        )
      ) {
        outcome = 'malformed'
        return []
      }
      controller.signal.throwIfAborted()
      outcome = 'success'
      return targets.map((language) => ({
        language,
        text: (value as Record<string, string>)[language].trim()
      }))
    } catch {
      if (outcome !== 'timeout' && controller.signal.aborted) outcome = 'cancelled'
      return []
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      this.active.delete(controller)
      logAutodocEvent({
        area: 'chat',
        message: 'Ask AI query translation',
        context: {
          outcome,
          targetCount: targets.length,
          durationMs: Math.round(performance.now() - started)
        }
      })
    }
  }
}
