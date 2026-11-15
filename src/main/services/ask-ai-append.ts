import { askAiAppendContext } from './ask-ai-writer-session'
import { createHash } from 'crypto'
import { conversationTokens } from './ask-ai-conversation'
import type { AskAiExcerpt } from './ask-ai-answer'
import type { ChatSourceCard } from './ask-ai-citations'
import type { WriterToolCall } from './ask-ai-writer-tools'

/** Enlarge the tested runtime/cache while retaining today's evidence packing. */
export function appendWriterContexts(normalNumCtx: number): {
  numCtx: number
  packingNumCtx: number
} {
  return askAiAppendContext() === 8192
    ? { numCtx: 8192, packingNumCtx: 4096 }
    : { numCtx: normalNumCtx, packingNumCtx: normalNumCtx }
}

export interface AppendWriterMessage {
  role: string
  content: string
  tool_calls?: WriterToolCall[]
  tool_name?: string
  tool_call_id?: string
}
interface PassageReference {
  n: number
  source?: ChatSourceCard
}
export interface AppendWriterState {
  replyLanguage?: string
  requestMessages?: AppendWriterMessage[]
  answerMessage?: AppendWriterMessage
  references: Record<string, PassageReference>
  residentIds: string[]
  nextNumber: number
}
export function createAppendWriterState(): AppendWriterState {
  return { references: {}, residentIds: [], nextNumber: 1 }
}
const wireCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export function appendPassageId(excerpt: AskAiExcerpt): string {
  return (
    excerpt.passageId ??
    createHash('sha256')
      .update(JSON.stringify([excerpt.meetingId, excerpt.kind, excerpt.text]))
      .digest('hex')
  )
}
export interface PackedWriterBlock {
  index: number
  text: string
}
export function estimateAppendRequestTokens(
  messages: AppendWriterMessage[],
  tools: unknown
): number {
  return (
    conversationTokens(
      messages
        .map(
          (message) =>
            message.content +
            (message.tool_calls ? JSON.stringify(message.tool_calls) : '') +
            (message.tool_name ?? '') +
            (message.tool_call_id ?? '')
        )
        .join('\n')
    ) +
    conversationTokens(JSON.stringify(tools)) +
    messages.length * 12
  )
}
export function prepareAppendWriterRequest(params: {
  state: AppendWriterState
  baselineMessages: AppendWriterMessage[]
  context: string
  packedBlocks: PackedWriterBlock[]
  excerpts: AskAiExcerpt[]
  sources: ChatSourceCard[]
  rules: string
  question: string
  tools: unknown
  numCtx: number
  reserveTokens: number
  fresh: boolean
  replyLanguage?: string
}): {
  messages: AppendWriterMessage[]
  sources: ChatSourceCard[]
  fallback: boolean
  layout: 'initial' | 'append' | 'fallback'
  estimatedTokens: number
  commit: (messages: AppendWriterMessage[], answer: string) => void
} {
  const initial = params.fresh || !params.state.requestMessages || !params.state.answerMessage
  const base = initial ? createAppendWriterState() : params.state
  const references = wireCopy(base.references)
  let nextNumber = base.nextNumber
  const currentIds = params.excerpts.map((excerpt, index) => {
    const id = appendPassageId(excerpt)
    if (!references[id]) references[id] = { n: nextNumber++ }
    if (params.sources[index])
      references[id].source = { ...params.sources[index], n: references[id].n }
    return id
  })
  const allBlocks = params.packedBlocks.map((block) => ({
    ...block,
    id: currentIds[block.index],
    text: block.text.replace(/^\[\d+\]/, `[${references[currentIds[block.index]].n}]`)
  }))
  const joined = params.packedBlocks.map((block) => block.text).join('\n\n')
  const start = joined ? params.context.indexOf(joined) : -1
  if (joined && start < 0) throw Error('Packed evidence spans do not match the writer context')
  const contextWith = (blocks: typeof allBlocks): string =>
    start < 0
      ? params.context
      : params.context.slice(0, start) +
        blocks.map((block) => block.text).join('\n\n') +
        params.context.slice(start + joined.length)
  let messages = params.baselineMessages
  let residentIds = allBlocks.map((block) => block.id)
  let layout: 'initial' | 'append' | 'fallback' = 'initial'
  if (!initial) {
    const resident = new Set(base.residentIds)
    const newBlocks = allBlocks.filter((block) => !resident.has(block.id))
    const appended = [
      ...wireCopy(base.requestMessages!),
      wireCopy(base.answerMessage!),
      { role: 'user', content: contextWith(newBlocks) + params.rules + '\n\n' + params.question }
    ]
    if (
      base.replyLanguage === params.replyLanguage &&
      estimateAppendRequestTokens(appended, params.tools) <= params.numCtx - params.reserveTokens
    ) {
      messages = appended
      residentIds = [...new Set([...base.residentIds, ...newBlocks.map((block) => block.id)])]
      layout = 'append'
    } else {
      messages = params.baselineMessages.map((message, index) =>
        index === 1 ? { ...message, content: contextWith(allBlocks) + params.rules } : message
      )
      layout = 'fallback'
    }
  }
  // Source links show this turn's passages, as initial and fallback turns do. Earlier
  // resident passages stay in the request but are only listed for the default-off
  // cited-card experiment, which resolves conversation-wide [n] markers (AD-202).
  const visibleIds =
    initial || layout === 'fallback' || process.env.AUTODOC_ASK_AI_CITED_CARDS !== '1'
      ? currentIds
      : [...residentIds, ...currentIds]
  const sources = initial
    ? params.sources
    : [...new Set(visibleIds)]
        .map((id) => references[id])
        .filter((ref) => ref.source)
        .sort((a, b) => a.n - b.n)
        .map((ref) => ref.source!)
  return {
    messages,
    sources,
    fallback: layout === 'fallback',
    layout,
    estimatedTokens: estimateAppendRequestTokens(messages, params.tools),
    commit: (sentMessages, answer) => {
      params.state.replyLanguage = params.replyLanguage
      params.state.requestMessages = wireCopy(sentMessages)
      params.state.answerMessage = { role: 'assistant', content: answer }
      params.state.references = references
      params.state.residentIds = residentIds
      params.state.nextNumber = nextNumber
    }
  }
}
