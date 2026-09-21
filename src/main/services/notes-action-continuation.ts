import type { MeetingNotesContent, Transcript } from '../../shared/types'
import { actionEvidenceTurns } from './notes-action-evidence'
import { explicitActionSpeechActClauses } from './notes-action-speech'

function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// A following explanation belongs to the commitment's utterance. Mere time
// proximity or a shared, normalized topic does not establish that relationship.
const EXPLANATION =
  /^(?:(?:yeah|so|well)[,.]?\s+)*(?:because\b|this is because\b|the reason\b|in order to\b|so that\b|it['’]s just\b)/iu
const QUALIFICATION = /^(?:but|however|unless|provided that|only if)\b/iu
const CONDITION = /^(?:unless|provided that|only if)\b/iu
const TOPIC_CHANGE =
  /^(?:(?:yeah|so|well|okay)[,.]?\s+)*(?:anyway\b|moving on\b|(?:the other|another|next)\s+(?:thing|issue|item|topic)\b)/iu

/** Restore explanatory continuations lost when recovery extracts a clause. */
export function restoreActionContinuations(
  content: MeetingNotesContent,
  transcript: readonly Transcript[]
): { content: MeetingNotesContent; count: number } {
  if (process.platform !== 'darwin') return { content, count: 0 }
  const eligible = content.nextSteps.filter(
    (item) =>
      item.provenance === 'generated' &&
      item.id.startsWith('recovered-action:') &&
      comparable(item.title ?? '') === comparable(item.text) &&
      item.sources.length === 1
  )
  if (!eligible.length) return { content, count: 0 }
  const rows = [...transcript].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const eligibleIds = new Set(eligible.map((item) => item.id))
  let count = 0
  const nextSteps = content.nextSteps.map((item) => {
    if (!eligibleIds.has(item.id)) return item
    const source = item.sources[0]
    const anchors = rows.filter(
      (row) =>
        row.startMs === source.startMs && comparable(row.text).includes(comparable(item.text))
    )
    if (anchors.length !== 1) return item
    const anchor = anchors[0]
    // Reconstruct only this short, continuous utterance, including ASR repeats
    // and backchannels. Do not cross a substantive change of speaker.
    const firstRow = rows.findIndex((row) => row.startMs >= anchor.startMs)
    const outside = rows.findIndex((row) => row.startMs > anchor.startMs + 30_000)
    // Keep one boundary row so a length limit cannot silently trim a caveat.
    const neighborhood = rows.slice(firstRow, outside < 0 ? undefined : outside + 1)
    const turns = actionEvidenceTurns(neighborhood)
    const anchorIndex = turns.findIndex((turn) => turn.rows.includes(anchor))
    if (anchorIndex < 0) return item
    const anchorTurn = turns[anchorIndex]
    const sentences = anchorTurn.text.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? []
    const actionSentence = sentences.findIndex((sentence) =>
      comparable(sentence).includes(comparable(item.text))
    )
    if (actionSentence < 0) return item
    const additions: string[] = []
    let endMs = Math.max(source.endMs, anchorTurn.rows.at(-1)!.endMs)
    let interrupted = false
    for (const sentence of sentences.slice(actionSentence + 1)) {
      const text = sentence.trim()
      if (!(EXPLANATION.test(text) || QUALIFICATION.test(text))) {
        interrupted = true
        break
      }
      additions.push(text)
    }
    for (let i = anchorIndex + 1; !interrupted && i < turns.length; i += 1) {
      const turn = turns[i]
      const first = turn.rows[0]
      const last = turn.rows.at(-1)!
      if (
        first.speaker !== anchor.speaker ||
        first.meetingId !== anchor.meetingId ||
        first.startMs - endMs > 1_000
      )
        break
      if (
        !(
          EXPLANATION.test(turn.text) ||
          CONDITION.test(turn.text) ||
          (additions.length > 0 && QUALIFICATION.test(turn.text))
        )
      ) {
        // Once an explanation starts, an adjacent unrecognized sentence could
        // qualify it. Never silently trim it and make the added claim stronger.
        if (
          additions.length &&
          !TOPIC_CHANGE.test(turn.text) &&
          !explicitActionSpeechActClauses(turn.text).length
        )
          return item
        break
      }
      if (last.endMs - anchor.startMs > 30_000) return item
      if (explicitActionSpeechActClauses(turn.text).length > 0) return item
      // A single ASR row can contain a topic change too. An explanatory
      // opening does not license copying everything after it.
      const continuationSentences = turn.text.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? []
      for (const sentence of continuationSentences) {
        const text = sentence.trim()
        if (!(EXPLANATION.test(text) || QUALIFICATION.test(text))) {
          interrupted = true
          break
        }
        additions.push(text)
      }
      endMs = Math.max(endMs, last.endMs)
    }
    const continuation = additions.join(' ').trim()
    if (
      interrupted ||
      !continuation ||
      // A speaker/channel boundary can interrupt an ASR sentence. A partial
      // explanation may omit its contrast or caveat, even if every word is real.
      !/[.!?]["'’”)]*\s*$/u.test(continuation) ||
      continuation.length > 600 ||
      explicitActionSpeechActClauses(continuation).length > 0 ||
      content.nextSteps.some(
        (other) =>
          other.id !== item.id &&
          other.sources.some((range) => range.startMs >= source.startMs && range.startMs <= endMs)
      )
    )
      return item

    count += 1
    return {
      ...item,
      title: null,
      text: `${item.text.trim()} ${continuation}`,
      sources: [{ startMs: source.startMs, endMs }]
    }
  })
  return { content: count ? { ...content, nextSteps } : content, count }
}
