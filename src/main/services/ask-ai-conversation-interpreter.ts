import {
  clipConversationText,
  recentConversation,
  type AskAiConversationTurn
} from './ask-ai-conversation'
import { chatReplyLanguageLabel } from './chat-reply-language'
import { logAutodocEvent } from './autodoc-log'

export class ConversationInterpretationError extends Error {}

export async function interpretConversation(params: {
  baseUrl: string
  model: string
  question: string
  history: AskAiConversationTurn[]
  fallbackLanguage: unknown
  numCtx: number
  signal?: AbortSignal
}): Promise<{
  operation: 'search' | 'clarify' | 'count' | 'list'
  subject: string
  query: string
  language: string
  clarification: string
}> {
  const started = performance.now()
  const system = `Resolve the current meeting-chat request. Do NOT answer.
operation: search for meeting content, count/list ONLY for the entire unfiltered saved-recording library, or clarify. For count/list leave subject, query and clarification EMPTY. Topic/date-filtered counts and numbers inside meeting content are SEARCH, never inventory operations.
subject: a CONCRETE project, meeting, object or topic quoted EXACTLY from the current request or recent exchange. Never use a pronoun as the subject. If no concrete subject is identified, leave it empty.
query: a standalone search question about that subject, resolving references from the exchange only. Preserve topic changes, constraints and comparison subjects. Do not add facts.
language: ISO code of requested output language, otherwise current request's language; ambiguous short replies use the exchange, then ${chatReplyLanguageLabel(params.fallbackLanguage)}.
clarification: ONE short question if subject is empty, otherwise empty. A named topic is enough to search; lack of factual details is not ambiguity.`
  const res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      stream: false,
      think: false,
      keep_alive: '10m',
      format: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['search', 'clarify', 'count', 'list'] },
          subject: { type: 'string' },
          query: { type: 'string' },
          language: { type: 'string' },
          clarification: { type: 'string' }
        },
        required: ['operation', 'subject', 'query', 'language', 'clarification'],
        additionalProperties: false
      },
      options: { num_ctx: params.numCtx, num_predict: 120, temperature: 0 },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            recent: recentConversation(params.history, 220),
            request: clipConversationText(params.question, 500)
          })
        }
      ]
    })
  })
  if (!res.ok) throw new Error(`Local question interpretation returned ${res.status}`)
  const data = (await res.json()) as {
    message?: { content?: string }
    prompt_eval_count?: number
    eval_count?: number
    load_duration?: number
  }
  params.signal?.throwIfAborted()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data.message?.content ?? '') as Record<string, unknown>
  } catch {
    throw new ConversationInterpretationError('Invalid local interpretation output')
  }
  if (
    !['search', 'clarify', 'count', 'list'].includes(String(parsed.operation)) ||
    typeof parsed.subject !== 'string' ||
    typeof parsed.query !== 'string' ||
    typeof parsed.clarification !== 'string' ||
    typeof parsed.language !== 'string' ||
    (!['count', 'list'].includes(String(parsed.operation)) &&
      !parsed.query.trim() &&
      !parsed.clarification.trim())
  )
    throw new ConversationInterpretationError('Incomplete local interpretation output')
  // Validate a locale, never a closed vocabulary of questions or follow-ups.
  try {
    new Intl.DisplayNames(['en'], { type: 'language' }).of(parsed.language)
  } catch {
    throw new ConversationInterpretationError('Invalid local interpretation language')
  }
  logAutodocEvent({
    area: 'chat',
    message: 'Ask AI conversation interpretation timing',
    context: {
      model: params.model,
      numCtx: params.numCtx,
      wallMs: Math.round(performance.now() - started),
      promptTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
      loadMs: data.load_duration ? data.load_duration / 1e6 : null,
      clarification: Boolean(parsed.clarification.trim())
    }
  })
  return {
    operation: parsed.operation as 'search' | 'clarify' | 'count' | 'list',
    subject: clipConversationText(parsed.subject.trim(), 80),
    query: clipConversationText(parsed.query.trim(), 500),
    language: parsed.language,
    clarification: clipConversationText(parsed.clarification.trim(), 100)
  }
}
