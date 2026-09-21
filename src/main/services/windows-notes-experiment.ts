import type { MeetingSegments, Segment } from '../../shared/types'
import { NEEDS_REVIEW_TOPIC, OTHER_NOTES_TOPIC } from '../../shared/notes-presentation'
import { noteTextLooksCoherent } from './notes-coherence'

/**
 * Default Windows notes quality path added after internal-v1.2.0.6.
 * macOS stays on last-release lossless present / export / overview.
 */
export function isWindowsNotesQualityEnabled(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32'
}

/** Opt-in experiment. The platform guard is mandatory even when the flag is set. */
export function isWindowsTopicWriterEnabled(
  platform: NodeJS.Platform = process.platform,
  enabled: string | undefined = process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER
): boolean {
  return (
    platform === 'win32' &&
    ['1', 'lines', 'catalog', 'whole', 'wide', 'semantic', 'outline', 'evidence'].includes(enabled ?? '')
  )
}

/**
 * V38 validation repairs on the default Windows grounding path. No extra model
 * call. Kill switch matches writer grounding. Topic-writer experiments keep
 * the same repairs.
 */
export function windowsGroundingRepairsEnabled(
  platform: NodeJS.Platform = process.platform,
  disabled: string | undefined = process.env.AUTODOC_DISABLE_WINDOWS_WRITER_GROUNDING
): boolean {
  if (isWindowsTopicWriterEnabled(platform)) return true
  return platform === 'win32' && disabled !== '1'
}

/** Number-word completion only. Does not change clause-boundary salvage. */
export function windowsNumberWordCompletionEnabled(
  platform: NodeJS.Platform = process.platform
): boolean {
  return windowsGroundingRepairsEnabled(platform)
}

export function isWindowsTopicLineWriterEnabled(): boolean {
  return (
    process.platform === 'win32' &&
    ['lines', 'catalog', 'whole', 'wide', 'semantic', 'outline', 'evidence'].includes(
      process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER ?? ''
    )
  )
}

export function isWindowsCatalogWriterEnabled(): boolean {
  return (
    process.platform === 'win32' &&
    ['catalog', 'whole', 'wide', 'semantic', 'outline'].includes(
      process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER ?? ''
    )
  )
}

export function isWindowsSemanticWriterEnabled(): boolean {
  return (
    process.platform === 'win32' && process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER === 'semantic'
  )
}

export function isWindowsOutlineWriterEnabled(): boolean {
  return process.platform === 'win32' && process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER === 'outline'
}

export function isWindowsWholeWriterEnabled(): boolean {
  return process.platform === 'win32' && process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER === 'whole'
}

export function isWindowsWideWriterEnabled(): boolean {
  return process.platform === 'win32' && process.env.AUTODOC_TEST_WINDOWS_TOPIC_WRITER === 'wide'
}

export const WINDOWS_WHOLE_WRITER_PROMPT = `Write useful standalone notes from this entire meeting. Select 20-32 consequential records, fewer for a sparse meeting. Invent nothing.
Return compact JSON tuples: d=explicit decisions, a=concrete follow-ups, i=facts/results, x=unresolved questions, u=progress/blockers. Omit empty categories.
Each record is [topic, note, firstLine, lastLine]. Source IDs are numeric: [L7] means 7. Cite the lines supporting the complete note.
Use consistent broad project/subject headings across the whole meeting, usually 3-8 topics. Related details share a heading. Never use a different heading for every record or combine unrelated subjects under generic Updates.
Each note is one complete 12-28 word sentence naming its subject. Preserve names, quantities, versions, owners, deadlines and conditions. Do not guess unclear words or invent causes or purposes.
Read later clarifications before summarizing earlier proposals. Prioritize chosen direction, important results, constraints and concrete deliverables. A suggestion is not a decision; an investigation is not a confirmed outcome. Include the condition when an action depends on it.
One claim in one category. No duplicate notes. Return ONLY JSON about this transcript.`

/** Long meetings defer all heading work to the one whole-catalog call. */
export const WINDOWS_CATALOG_WRITER_PROMPT = `Extract at most 6 important meeting records. Invent nothing. Skip chatter, filler and unclear fragments.
Return compact JSON: d=explicit decisions, a=concrete follow-ups, i=facts/results, x=open questions, u=progress/blockers. Omit empty categories.
Each item is an object with c (note sentence), s (first source line ID), e (last source line ID). For a line marked [L7], the source ID is 7. Include owners and deadlines in the sentence only when explicit.
Write one complete 12-28 word sentence per note, naming its subject. Keep source wording where possible. Preserve names, quantities, versions, timing and conditions. Suggestions are not decisions.
Do not infer a cause, purpose or agreement from nearby statements about another subject. Omit unsupported explanations. One claim in one category. Do not write titles or topic labels.
Return ONLY JSON about the provided transcript.`

const CATALOG_ITEMS = {
  type: 'array',
  maxItems: 6,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { c: { type: 'string' }, s: { type: 'integer' }, e: { type: 'integer' } },
    required: ['c', 's', 'e']
  }
} as const
export const WINDOWS_CATALOG_WRITER_FORMAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    d: CATALOG_ITEMS,
    a: CATALOG_ITEMS,
    i: CATALOG_ITEMS,
    x: CATALOG_ITEMS,
    u: CATALOG_ITEMS
  }
} as const

/** Extend existing person-name patterns without changing the macOS path. */
export function windowsPersonPattern(pattern: RegExp): RegExp {
  if (!isWindowsTopicWriterEnabled() || !pattern.source.includes('[A-Z][a-z]{1,}')) return pattern
  return new RegExp(
    pattern.source
      .replaceAll('[A-Z][a-z]{1,}', "\\p{Lu}[\\p{L}'’-]+")
      .replace(/^\\b/u, '(?<![\\p{L}\\p{N}])'),
    pattern.flags
  )
}

/** Copy local line IDs instead of generating clock arithmetic; keep the sentence contract. */
export const WINDOWS_TOPIC_LINE_WRITER_PROMPT = `Extract meeting notes as compact JSON tuples. Invent nothing. Skip chatter, filler and unclear fragments.
Categories: d=explicit decisions a=concrete follow-ups i=facts and results x=open questions u=progress and blockers.
Each item MUST have four fields: [topic, note, firstLine, lastLine]. Actions may append owner and deadline only when explicit.
Copy numeric transcript line IDs: [L7] through [L9] means 7,9. Cite the lines supporting the complete note.
At most 6 items total. Omit empty categories. One claim in one category.
- Topic is a reusable 2-4 word subject heading. Related records share a topic.
- Note is one complete 12-28 word sentence naming the subject and the outcome, condition or concrete follow-up. No unresolved pronouns.
- Preserve exact names, numbers, versions, timing and uncertainty. Do not guess unclear words.
- Prefer explicit priorities, decisions, commitments and consequential results. Suggestions are not decisions.
Return ONLY valid JSON with numeric line IDs, for example:
{"i":[["Supplier renewal","The supplier offered a one-year renewal at the current price.",7,9]]}`

export const WINDOWS_WIDE_WRITER_PROMPT =
  WINDOWS_TOPIC_LINE_WRITER_PROMPT.replace('At most 6 items total.', 'At most 12 items total.') +
  '\nRead clarifications within this excerpt before summarizing proposals. Do not infer a cause, purpose or agreement from adjacent statements about different subjects.'

export const WINDOWS_TOPIC_WRITER_PROMPT = `Extract meeting notes as compact JSON tuples. Invent nothing. Skip chatter, filler and unclear fragments.
Categories: d=explicit decisions a=concrete follow-ups i=facts and results x=open questions u=progress and blockers.
Each item MUST have four fields: [topic, note, startMilliseconds, endMilliseconds]. Actions may append owner and deadline only when explicit.
Copy transcript clocks as milliseconds: [00:22]=22000, [02:30]=150000, [17:41]=1061000.
At most 6 items total. Omit empty categories. One claim in one category.
- Topic is a reusable 2-4 word subject heading. Related records share a topic.
- Note is one complete 12-28 word sentence naming the subject and the outcome, condition or concrete follow-up. No unresolved pronouns.
- Preserve exact names, numbers, versions, timing and uncertainty. Do not guess unclear words.
- Prefer explicit priorities, decisions, commitments and consequential results. Suggestions are not decisions.
Return ONLY valid JSON with numeric timestamps, for example:
{"i":[["Supplier renewal","The supplier offered a one-year renewal at the current price.",22000,30000]]}`

export function windowsNoteNeedsReview(segment: Segment): boolean {
  const text = segment.content.trim()
  if (!noteTextLooksCoherent(text) || /\uFFFD/u.test(text)) return true
  // A real subject must be present in the sentence; a heading cannot resolve a pronoun.
  if (
    /^(?:it|they)\b|^(?:this|that|those|these)\s+(?:is|are|was|were|will|would|can|could|has|have)\b/iu.test(
      text
    )
  )
    return true
  if (/\b(?:um+|uh+)\b/iu.test(text)) return true
  if (
    /^(?:ask you(?: a question)?|give some feedback|make sure we do this(?: properly)?)[.!?]*$/iu.test(
      text
    )
  )
    return true
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  if (words.length <= 3 && /^(?:share|send|discuss|look)\b/iu.test(text)) return true
  if (/^look\s+into\s+make\s+sure\b/iu.test(text)) return true
  if (text.length <= 42 && /^(?:but|and|then|so)\b/iu.test(text) && !/\d/.test(text)) return true
  if (/^send the link\b/iu.test(text) && !/https?:\/\//iu.test(text)) return true
  if (segment.id.startsWith('recovered-')) {
    if (words.length < 3) return true
    if (/\b(?:which one|the same|the link|the updated version)\b/iu.test(text)) return true
  }
  return false
}

export function windowsRecoveryIsUsable(text: string): boolean {
  if (/\b(?:which one|the same|the link|the updated version)\b/iu.test(text)) return false
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  if (words.length <= 3 && /^(?:share|send|discuss|look)\b/iu.test(text)) return false
  if (/^look\s+into\s+make\s+sure\b/iu.test(text)) return false
  if (/^(?:keep|use|do|share)\s+(?:it|that|this|those|these)\b/iu.test(text)) return false
  if (/^(?:send|review|check|update)\s+(?:that|this)\s+(?:email|link|version|one)\b/iu.test(text))
    return false
  if (/^(?:share|show)\s+(?:my|your|the|a)\s+screen\b/iu.test(text)) return false
  // Conversation management is not a future deliverable. An explicit future
  // time can distinguish a scheduled discussion from the current discussion.
  if (
    /^(?:agree|discuss|focus|talk|start\s+with|begin\s+with)\b/iu.test(text) &&
    !/\b(?:by|tomorrow|next\s+\w+|after\s+the\s+meeting)\b/iu.test(text)
  )
    return false
  return true
}

export function dedupeWindowsNotes(segments: MeetingSegments): MeetingSegments {
  const seen = new Set<string>()
  const result = {} as MeetingSegments
  // Keep the actionable copy when malformed output repeated it in a fact bucket.
  for (const key of [
    'decisions',
    'actionItems',
    'information',
    'discussion',
    'statusUpdates'
  ] as const) {
    result[key] = segments[key].filter((segment) => {
      const normalized = segment.content
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
      const identity = `${segment.assignee ?? ''}\0${segment.deadline ?? ''}\0${normalized}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }
  return result
}

/** Only normalizes the spelling/case of existing labels. Never merges by time or group count. */
export function assignWindowsPresentationTopics(segments: MeetingSegments): MeetingSegments {
  const labels = new Map<string, string>()
  const result = {} as MeetingSegments
  for (const key of Object.keys(segments) as Array<keyof MeetingSegments>) {
    result[key] = segments[key].map((segment) => {
      const label = segment.topic?.replace(/\s+/gu, ' ').trim() || OTHER_NOTES_TOPIC
      const normalized = label.toLocaleLowerCase()
      const topic = labels.get(normalized) ?? label
      labels.set(normalized, topic)
      return { ...segment, topic: windowsNoteNeedsReview(segment) ? NEEDS_REVIEW_TOPIC : topic }
    })
  }
  return result
}
