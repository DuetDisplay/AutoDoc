import type { MeetingNotesContent, Segment, Transcript } from '../../shared/types'
import { refineWriterAction } from './notes-writer-grounding'
import { actionPredicatesOverlap, isUnscopedSocialCommitment } from './notes-action-speech'
import { resolveSpeakerAwareOwner } from './notes-owner-attribution'

// Used only to require preservation of an existing task's specific words,
// never to decide whether a task exists or should be deleted.
const FILLER = new Set(
  'a an the i we you it this that them will ll to of and just some bunch'.split(' ')
)
function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (word) => !FILLER.has(word)
  )
}

function sameText(left: string | null, right: string): boolean {
  return (
    (left ?? '')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim() ===
    right
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  )
}

export function refineNextSteps(
  content: MeetingNotesContent,
  candidates: readonly Segment[],
  transcript: readonly Transcript[],
  localOwnerLabel?: string | null
): { content: MeetingNotesContent; count: number } {
  if (!candidates.length) return { content, count: 0 }
  const rows = [...transcript].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const nextSteps = [...content.nextSteps]
  let count = 0
  for (const draft of candidates) {
    // Apply the existing recovery rule here too; a rejected writer draft must
    // not bypass the distinction between social chatter and a scoped task.
    if (isUnscopedSocialCommitment(draft.content)) continue
    const refined = refineWriterAction(draft, rows)
    if (!refined) continue
    const { segment, commitmentRows, contextRows } = refined
    const matching = nextSteps.flatMap((item, index) =>
      item.provenance === 'generated' &&
      item.sources.some((source) => commitmentRows.some((row) => source.startMs === row.startMs)) &&
      actionPredicatesOverlap(item.text, segment.content)
        ? [index]
        : []
    )
    // Another task in the local context may supply the subject of this draft.
    // Until its relationship is unambiguous, retain the existing tasks rather
    // than append or expand a second description of their work. Use the whole
    // inspected neighborhood, not a smaller window chosen by grounding.
    if (
      nextSteps.some(
        (item, index) =>
          !matching.includes(index) &&
          item.sources.some((source) =>
            contextRows.some((row) => source.startMs >= row.startMs && source.startMs < row.endMs)
          )
      )
    )
      continue
    const sources = [{ startMs: segment.sourceStartMs, endMs: segment.sourceEndMs }]
    if (matching.length) {
      // Multiple tasks at one anchor are ambiguous; keep them all unchanged.
      if (matching.length !== 1) continue
      const index = matching[0]
      const item = nextSteps[index]
      const proposedWords = new Set(words(segment.content))
      if (!words(item.text).every((word) => proposedWords.has(word))) continue
      if (sameText(item.text, segment.content) && sameText(item.title, segment.title)) continue
      nextSteps[index] = { ...item, title: segment.title, text: segment.content, sources }
    } else {
      if (nextSteps.some((item) => item.id === segment.id)) continue
      const item = {
        id: segment.id,
        title: segment.title,
        text: segment.content,
        topic: segment.topic,
        owner: resolveSpeakerAwareOwner(segment, rows, localOwnerLabel),
        deadline: segment.deadline,
        sources,
        provenance: 'generated' as const,
        completed: false
      }
      const position = nextSteps.findIndex(
        (existing) =>
          existing.sources.length > 0 && existing.sources[0].startMs > segment.sourceStartMs
      )
      nextSteps.splice(position < 0 ? nextSteps.length : position, 0, item)
    }
    count += 1
  }
  return { content: count ? { ...content, nextSteps } : content, count }
}

/** Apply grounded title context after ranking, recovery, and owner attribution. */
export function presentActionContext(
  content: MeetingNotesContent,
  actions: readonly Segment[]
): { content: MeetingNotesContent; count: number } {
  if (!actions.some((action) => action.actionContext)) return { content, count: 0 }
  const byId = new Map(actions.map((action) => [action.id, action]))
  let count = 0
  const nextSteps = content.nextSteps.map((item) => {
    const action = byId.get(item.id)
    const context = action?.actionContext
    if (
      !action ||
      !context ||
      typeof context.title !== 'string' ||
      !context.title.trim() ||
      !Number.isFinite(context.sourceStartMs) ||
      !Number.isFinite(context.sourceEndMs) ||
      context.sourceStartMs < 0 ||
      context.sourceStartMs > action.sourceStartMs ||
      context.sourceEndMs < action.sourceEndMs ||
      item.provenance !== 'generated' ||
      item.title !== action.title ||
      item.text !== action.content ||
      item.sources.length !== 1 ||
      item.sources[0].startMs !== action.sourceStartMs ||
      item.sources[0].endMs !== action.sourceEndMs
    )
      return item
    count += 1
    return {
      ...item,
      title: context.title,
      sources: [{ startMs: context.sourceStartMs, endMs: context.sourceEndMs }]
    }
  })
  return { content: count ? { ...content, nextSteps } : content, count }
}
