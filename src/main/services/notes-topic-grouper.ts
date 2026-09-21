import type { MeetingSegments, Segment } from '../../shared/types'
import {
  isLeftoverPresentationTitle,
  LEFTOVER_PRESENTATION_TITLE,
  NEEDS_REVIEW_TOPIC,
  OTHER_NOTES_TOPIC
} from '../../shared/notes-presentation'
import { noteRecordNeedsReview } from './notes-coherence'
import { isGenericGroupName, ticketsInText } from './notes-scan-preserve'
import { windowsNoteNeedsReview } from './windows-notes-experiment'

const STOP = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'been',
  'will',
  'were',
  'they',
  'them',
  'then',
  'than',
  'into',
  'over',
  'also',
  'just',
  'only',
  'more',
  'some',
  'such',
  'very',
  'when',
  'what',
  'which',
  'while',
  'after',
  'before',
  'about',
  'there',
  'their',
  'would',
  'could',
  'should',
  'still',
  'same',
  'make',
  'sure',
  'need',
  'using',
  'used',
  'team',
  'item',
  'note',
  'notes',
  'update',
  'updates',
  'discuss',
  'discussed',
  'discussion',
  'information',
  'status',
  'today',
  'tomorrow',
  'yesterday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'title',
  'content'
])

const VERSION_RE = /\b\d+(?:\.\d+){1,3}\b/gu
const WORD_RE = /[a-z0-9]+/gu
const CLOSE_GAP_MS = 90_000
const NEAR_GAP_MS = 180_000
const TITLE_MAX = 52
const TITLE_MAX_WORDS = 8
const MAX_NAMED_GROUPS = 10
const LEFTOVER_STEMS = new Set([
  'identifi',
  'identif',
  'indicat',
  'us',
  'runn',
  'updat',
  'creat',
  'post',
  'show',
  'consider',
  'share',
  'look',
  'discuss',
  'send',
  'includ'
])
const SHORT_KEEP = new Set(['duet', 'icon', 'mac', 'ram'])
const WEAK_SINGLE_WORD = new Set(['link', 'host', 'item', 'note', 'team', 'page', 'flag'])
const WEAK_NAME_WORD = new Set([
  ...WEAK_SINGLE_WORD,
  'reevaluation',
  'screenshot',
  'confusion',
  'behavior',
  'problem',
  'issue',
  'issues',
  'content',
  'output',
  'chance'
])
const QUANTIFIED = /(?:\b\d+(?:[.,]\d+)?\b|%)/u

const BUCKETS = [
  'decisions',
  'actionItems',
  'information',
  'discussion',
  'statusUpdates'
] as const satisfies ReadonlyArray<keyof MeetingSegments>

function cloneSegments(segments: MeetingSegments): MeetingSegments {
  return {
    decisions: segments.decisions.map((segment) => ({ ...segment })),
    actionItems: segments.actionItems.map((segment) => ({ ...segment })),
    information: segments.information.map((segment) => ({ ...segment })),
    discussion: segments.discussion.map((segment) => ({ ...segment })),
    statusUpdates: segments.statusUpdates.map((segment) => ({ ...segment }))
  }
}

function allSegments(segments: MeetingSegments): Segment[] {
  return BUCKETS.flatMap((key) => segments[key])
}

function lightStem(token: string): string {
  if (token.endsWith('ing') && token.length > 6) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 5) return token.slice(0, -2)
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 4) return token.slice(0, -1)
  return token
}

function isLeftoverToken(raw: string): boolean {
  return LEFTOVER_PRESENTATION_TITLE.test(raw) || LEFTOVER_STEMS.has(lightStem(raw))
}

function leftoverFragment(segment: Segment): boolean {
  const content = segment.content.replace(/\s+/gu, ' ').trim()
  if (/\d/.test(content) || content.length > 42) return false
  return (
    isLeftoverPresentationTitle(segment.title) || isLeftoverPresentationTitle(content)
  )
}

function distinctiveTerms(segment: Segment): Set<string> {
  const terms = new Set<string>()
  const blob = `${segment.title} ${segment.content}`
  for (const ticket of ticketsInText(blob)) terms.add(ticket)
  for (const match of blob.matchAll(new RegExp(VERSION_RE.source, VERSION_RE.flags))) {
    terms.add(match[0])
  }
  const titleWords = segment.title.toLowerCase().match(WORD_RE) ?? []
  for (const raw of titleWords) {
    if (STOP.has(raw) || isLeftoverToken(raw)) continue
    if (raw.length < 4 && !SHORT_KEEP.has(raw)) continue
    terms.add(lightStem(raw))
  }
  const contentWords = segment.content.toLowerCase().match(WORD_RE) ?? []
  for (const raw of contentWords) {
    if (STOP.has(raw) || isLeftoverToken(raw)) continue
    if (raw.length < 5 && !SHORT_KEEP.has(raw)) continue
    terms.add(lightStem(raw))
  }
  return terms
}

function sharedCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const term of left) {
    if (right.has(term)) count += 1
  }
  return count
}

function specificTitle(title: string): string {
  const trimmed = title.replace(/[.]+$/u, '').trim()
  if (!trimmed || isGenericGroupName(trimmed) || isLeftoverPresentationTitle(trimmed)) return ''
  if (trimmed.length > TITLE_MAX) return ''
  const words = trimmed.split(/\s+/u)
  if (words.length === 0 || words.length > TITLE_MAX_WORDS) return ''
  if (words.length === 1 && (trimmed.length < 5 || WEAK_SINGLE_WORD.has(trimmed.toLowerCase()))) {
    return ''
  }
  return trimmed
}

function copiedPhrase(members: readonly Segment[]): string {
  const titles = members
    .map((segment) => specificTitle(segment.title))
    .filter((title) => title.length > 0)
  const scored = [...new Set(titles)]
    .map((title) => {
      const needle = title.toLocaleLowerCase()
      const hits = members.filter(
        (segment) =>
          segment.title.toLocaleLowerCase().includes(needle) ||
          segment.content.toLocaleLowerCase().includes(needle)
      ).length
      return { title, hits }
    })
    .filter((row) => row.hits > 0)
    .sort(
      (left, right) =>
        right.hits - left.hits || left.title.length - right.title.length || left.title.localeCompare(right.title)
    )
  const majority = scored.find((row) => row.hits >= Math.max(2, Math.ceil(members.length / 2)))
  if (majority) return majority.title
  if (members.length <= 3) return scored[0]?.title ?? ''
  return ''
}

function capitalizeWord(word: string): string {
  return word.replace(/^\p{L}/u, (char) => char.toUpperCase())
}

function namingNouns(segment: Segment): string[] {
  const blob = `${segment.title} ${segment.content}`.toLowerCase()
  return (blob.match(WORD_RE) ?? []).filter(
    (raw) =>
      (raw.length >= 5 || SHORT_KEEP.has(raw)) &&
      !STOP.has(raw) &&
      !/^\d/.test(raw) &&
      !isLeftoverToken(raw) &&
      !WEAK_NAME_WORD.has(raw) &&
      !SHORT_KEEP.has(raw)
  )
}

function clusterName(members: readonly Segment[]): string {
  const copied = copiedPhrase(members)
  if (copied) return copied

  const counts = new Map<string, number>()
  for (const segment of members) {
    for (const raw of namingNouns(segment)) {
      counts.set(raw, (counts.get(raw) ?? 0) + 1)
    }
  }
  const ranked = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0])
  )
  const majority = ranked.find(([, count]) => count >= Math.max(2, Math.ceil(members.length / 2)))
  if (majority) return capitalizeWord(majority[0])
  if (members.length <= 3 && ranked[0]) return capitalizeWord(ranked[0][0])
  const fallbackTitle = members
    .map((segment) => specificTitle(segment.title))
    .filter((title) => title.length > 0)
    .sort((left, right) => left.length - right.length || left.localeCompare(right))[0]
  return fallbackTitle || OTHER_NOTES_TOPIC
}

function shouldUnion(
  left: { segment: Segment; terms: Set<string> },
  right: { segment: Segment; terms: Set<string> }
): boolean {
  const shared = sharedCount(left.terms, right.terms)
  if (shared >= 3) return true
  const productShared = [...left.terms].filter((term) => right.terms.has(term) && SHORT_KEEP.has(term)).length
  if (shared >= 2 && productShared >= 1) return true
  const leftTickets = ticketsInText(`${left.segment.title} ${left.segment.content}`)
  const rightTickets = ticketsInText(`${right.segment.title} ${right.segment.content}`)
  if (leftTickets.some((ticket) => rightTickets.includes(ticket))) return true
  const gap = Math.abs(left.segment.sourceStartMs - right.segment.sourceStartMs)
  if (gap <= CLOSE_GAP_MS && shared >= 2) return true
  if (gap <= NEAR_GAP_MS && shared >= 2) return true
  return false
}

function findRoot(parent: number[], index: number): number {
  let current = index
  while (parent[current] !== current) {
    parent[current] = parent[parent[current] ?? current] ?? current
    current = parent[current] ?? current
  }
  return current
}

function union(parent: number[], left: number, right: number): void {
  const leftRoot = findRoot(parent, left)
  const rightRoot = findRoot(parent, right)
  if (leftRoot === rightRoot) return
  parent[rightRoot] = leftRoot
}

function existingTopic(segment: Segment): string {
  return segment.topic?.trim() ?? ''
}

/**
 * Assigns presentation topics without rewriting record text, owners, deadlines,
 * IDs, or source spans. Writer-supplied topics are kept. Every record is
 * assigned exactly once.
 */
export function assignPresentationTopics(segments: MeetingSegments): MeetingSegments {
  const next = cloneSegments(segments)
  const rows = allSegments(next).map((segment, index) => ({
    segment,
    index,
    terms: distinctiveTerms(segment)
  }))
  const parent = rows.map((_, index) => index)
  const locked = new Set<number>()

  for (const row of rows) {
    if (
      noteRecordNeedsReview(row.segment.content) ||
      windowsNoteNeedsReview(row.segment) ||
      leftoverFragment(row.segment)
    ) {
      row.segment.topic = NEEDS_REVIEW_TOPIC
      locked.add(row.index)
      continue
    }
    const writerTopic = existingTopic(row.segment)
    if (writerTopic) {
      row.segment.topic = writerTopic
      locked.add(row.index)
    }
  }

  const unlocked = rows.filter((row) => !locked.has(row.index))
  for (let i = 0; i < unlocked.length; i += 1) {
    const left = unlocked[i]
    if (!left) continue
    for (let j = i + 1; j < unlocked.length; j += 1) {
      const right = unlocked[j]
      if (!right) continue
      if (shouldUnion(left, right)) union(parent, left.index, right.index)
    }
  }

  const clusters = new Map<number, Segment[]>()
  for (const row of unlocked) {
    const root = findRoot(parent, row.index)
    const members = clusters.get(root) ?? []
    members.push(row.segment)
    clusters.set(root, members)
  }

  const named = new Map<string, Segment[]>()
  for (const members of clusters.values()) {
    const only = members[0]!
    const weakSingleton =
      members.length === 1 &&
      !specificTitle(only.title) &&
      distinctiveTerms(only).size < 3 &&
      ticketsInText(`${only.title} ${only.content}`).length === 0
    const name = weakSingleton ? OTHER_NOTES_TOPIC : clusterName(members)
    const existing = named.get(name) ?? []
    existing.push(...members)
    named.set(name, existing)
  }

  const merged = mergeExcessGroups(named)
  for (const [name, members] of merged) {
    for (const segment of members) {
      segment.topic = name
    }
  }

  return next
}

function groupStrength(group: { name: string; members: Segment[] }): number {
  if (group.name === OTHER_NOTES_TOPIC) return -1
  const words = group.name.split(/\s+/u)
  const leftover = isLeftoverPresentationTitle(group.name) || words.length === 1
  const quantified = group.members.some((segment) => QUANTIFIED.test(`${segment.title} ${segment.content}`))
  return (
    group.members.length * 10 +
    words.length +
    (quantified ? 40 : 0) -
    (leftover ? 20 : 0)
  )
}

function mergeExcessGroups(named: Map<string, Segment[]>): Map<string, Segment[]> {
  const groups = [...named.entries()]
    .filter(([name]) => name !== NEEDS_REVIEW_TOPIC)
    .map(([name, members]) => ({ name, members }))
  const locked = named.get(NEEDS_REVIEW_TOPIC)

  const namedCount = (): number => groups.filter((group) => group.name !== OTHER_NOTES_TOPIC).length

  while (namedCount() > MAX_NAMED_GROUPS) {
    let weakest = -1
    for (let i = 0; i < groups.length; i += 1) {
      const current = groups[i]
      if (!current || current.name === OTHER_NOTES_TOPIC) continue
      if (weakest < 0 || groupStrength(current) < groupStrength(groups[weakest]!)) {
        weakest = i
      }
    }
    if (weakest < 0) break
    const dumped = groups.splice(weakest, 1)[0]
    if (!dumped) break
    const other = groups.find((group) => group.name === OTHER_NOTES_TOPIC)
    if (other) {
      other.members.push(...dumped.members)
    } else {
      groups.push({ name: OTHER_NOTES_TOPIC, members: dumped.members })
    }
  }

  const next = new Map<string, Segment[]>()
  for (const group of groups) {
    const existing = next.get(group.name) ?? []
    existing.push(...group.members)
    next.set(group.name, existing)
  }
  if (locked && locked.length > 0) next.set(NEEDS_REVIEW_TOPIC, locked)
  return next
}
