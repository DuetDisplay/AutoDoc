import { createHash } from 'crypto'
import type {
  MeetingNotesContent,
  MeetingSegments,
  NoteItem,
  NoteSection,
  Segment,
  SegmentCategory
} from '../../shared/types'
import {
  distinctNoteTitle,
  GENERIC_SECTION_TITLES,
  isLeftoverPresentationTitle,
  NEEDS_REVIEW_TOPIC,
  OTHER_NOTES_TOPIC,
  isOtherNotesTopic
} from '../../shared/notes-presentation'
import { normalizeNoteSources } from './notes-revision'
import { parseMeetingNotesContent } from './notes-schema'
import {
  noteRecordNeedsReview,
  noteSubjectIsResolved,
  noteTextLooksCoherent
} from './notes-coherence'
import { assignPresentationTopics } from './notes-topic-grouper'
import {
  assignWindowsPresentationTopics,
  isWindowsNotesQualityEnabled,
  isWindowsTopicWriterEnabled,
  windowsNoteNeedsReview
} from './windows-notes-experiment'

const SEGMENT_BUCKETS = [
  { key: 'decisions', category: 'decision', location: 'decision' },
  { key: 'actionItems', category: 'action_item', location: 'next-step' },
  { key: 'information', category: 'information', location: 'section' },
  { key: 'discussion', category: 'discussion', location: 'section' },
  { key: 'statusUpdates', category: 'status_update', location: 'section' }
] as const satisfies ReadonlyArray<{
  key: keyof MeetingSegments
  category: SegmentCategory
  location: 'decision' | 'next-step' | 'section'
}>

const SECTION_BUCKETS = [
  { key: 'information', category: 'information', fallbackTitle: 'Information' },
  { key: 'discussion', category: 'discussion', fallbackTitle: 'Discussion' },
  { key: 'statusUpdates', category: 'status_update', fallbackTitle: 'Status Updates' }
] as const satisfies ReadonlyArray<{
  key: 'information' | 'discussion' | 'statusUpdates'
  category: Extract<SegmentCategory, 'information' | 'discussion' | 'status_update'>
  fallbackTitle: string
}>

type SectionCategory = (typeof SECTION_BUCKETS)[number]['category']
type SectionKind = 'topical' | SectionCategory
type PresentedLocation = 'decision' | 'next-step' | 'section'

const LOSSLESS_SECTION_ID = /^lossless-section:(topical|information|discussion|status_update):/u

export type LosslessPresenterErrorCode =
  | 'invalid-meeting-id'
  | 'meeting-mismatch'
  | 'category-mismatch'
  | 'duplicate-segment-id'
  | 'incompatible-summary-catalog'
  | 'coverage-fallback-failed'

export class LosslessPresenterError extends Error {
  constructor(readonly code: LosslessPresenterErrorCode) {
    super(`Lossless notes presentation failed: ${code}`)
    this.name = 'LosslessPresenterError'
  }
}

interface ExpectedItem {
  segment: Segment
  location: PresentedLocation
}

interface PresentedItem {
  item: NoteItem
  location: PresentedLocation | null
}

const DERIVED_TAKEAWAY_ID = /^lossless-takeaway:/u
const QUANTIFIED_SIGNAL = /(?:\b\d+(?:[.,]\d+)?\b|%)/u
const MAC_QUANTIFIED_SIGNAL =
  /(?:\b\d+(?:[.,]\d+)?\b|%|\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday)\b)/iu
const MATERIAL_SIGNAL =
  /\b(?:approved|blocked|canceled|cancelled|changed|complete|completed|decreased|failed|failure|increased|launched|passed|resolved|risk|shipped|waiting)\b/iu
const UNRESOLVED_COMPARISON =
  /\b(?:the same as|still the same|same as yesterday|do this properly)\b/iu
const SUMMARY_WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu

export interface LosslessPresentationStats {
  topicCoveragePercent: number
  genericHeadingPercent: number
  needsReviewCount: number
  contextDependentRejected: number
  groupingFallback: boolean
}

export interface LosslessPresentationOptions {
  /** Same records and factual fields, used so body regrouping cannot reshuffle highlights. */
  summarySegments?: MeetingSegments
}

function standaloneCompletenessScore(text: string): number {
  const wordCount = text.match(SUMMARY_WORD)?.length ?? 0
  if (wordCount >= 12) return 8
  if (wordCount >= 8) return 4
  return 0
}

function expectedItems(segments: MeetingSegments): ExpectedItem[] {
  return SEGMENT_BUCKETS.flatMap(({ key, location }) =>
    segments[key].map((segment) => ({
      segment,
      location: process.platform === 'darwin' && location === 'decision' ? 'section' : location
    }))
  )
}

function validateInput(meetingId: string, segments: MeetingSegments): void {
  if (!meetingId) throw new LosslessPresenterError('invalid-meeting-id')

  const ids = new Set<string>()
  for (const { key, category } of SEGMENT_BUCKETS) {
    for (const segment of segments[key]) {
      if (segment.meetingId !== meetingId) {
        throw new LosslessPresenterError('meeting-mismatch')
      }
      if (segment.category !== category) {
        throw new LosslessPresenterError('category-mismatch')
      }
      if (ids.has(segment.id)) {
        throw new LosslessPresenterError('duplicate-segment-id')
      }
      ids.add(segment.id)
    }
  }
}

function toNoteItem(segment: Segment): NoteItem {
  return {
    id: segment.id,
    title: segment.title,
    topic: segment.topic,
    owner: segment.assignee,
    deadline: segment.deadline,
    text: segment.content,
    sources: [{ startMs: segment.sourceStartMs, endMs: segment.sourceEndMs }],
    provenance: 'generated',
    completed: false
  }
}

function stableSortSegments(segments: readonly Segment[]): Segment[] {
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort(
      (left, right) =>
        left.segment.sourceStartMs - right.segment.sourceStartMs ||
        left.segment.sourceEndMs - right.segment.sourceEndMs ||
        left.index - right.index
    )
    .map(({ segment }) => segment)
}

function summaryScore(segment: Segment): number {
  const text = `${segment.title} ${segment.content}`
  if (!isWindowsNotesQualityEnabled()) {
    const categoryScore: Record<SegmentCategory, number> = {
      decision: 100,
      status_update: 60,
      information: 50,
      action_item: 40,
      discussion: 30
    }
    return (
      categoryScore[segment.category] +
      (MAC_QUANTIFIED_SIGNAL.test(text) ? 20 : 0) +
      (MATERIAL_SIGNAL.test(text) ? 12 : 0) +
      standaloneCompletenessScore(segment.content) +
      (segment.deadline ? 8 : 0) +
      (segment.topic?.trim() ? 3 : 0)
    )
  }
  const categoryScore: Record<SegmentCategory, number> = {
    decision: 70,
    status_update: 60,
    information: 50,
    action_item: 40,
    discussion: 30
  }
  const topic = segment.topic?.trim() ?? ''
  const topicBonus = topic && topic !== OTHER_NOTES_TOPIC && topic !== NEEDS_REVIEW_TOPIC ? 8 : 0
  return (
    categoryScore[segment.category] +
    (QUANTIFIED_SIGNAL.test(text) ? 20 : 0) +
    (MATERIAL_SIGNAL.test(text) ? 12 : 0) +
    standaloneCompletenessScore(segment.content) +
    (segment.deadline ? 8 : 0) +
    topicBonus -
    (UNRESOLVED_COMPARISON.test(text) ? 24 : 0)
  )
}

function isPromotable(segment: Segment): boolean {
  if (segment.topic === NEEDS_REVIEW_TOPIC) return false
  if (windowsNoteNeedsReview(segment) || noteRecordNeedsReview(segment.content)) return false
  if (!noteTextLooksCoherent(segment.content)) return false
  return noteSubjectIsResolved(segment.content, segment.title, segment.topic)
}

function isOverviewCandidate(segment: Segment): boolean {
  if (!isPromotable(segment)) return false
  if (UNRESOLVED_COMPARISON.test(segment.content)) return false
  if (isLeftoverPresentationTitle(segment.title) || isLeftoverPresentationTitle(segment.topic)) {
    return false
  }
  const text = `${segment.title} ${segment.content}`
  return (
    standaloneCompletenessScore(segment.content) > 0 ||
    QUANTIFIED_SIGNAL.test(text) ||
    MATERIAL_SIGNAL.test(text)
  )
}

function composeOverview(selected: readonly Segment[]): MeetingNotesContent['overview'] {
  if (selected.length === 0) return null
  if (!isWindowsNotesQualityEnabled()) {
    const overviewSource = selected[0]
    if (!overviewSource) return null
    return {
      text: overviewSource.content,
      sources: [{ startMs: overviewSource.sourceStartMs, endMs: overviewSource.sourceEndMs }],
      provenance: 'generated'
    }
  }
  return {
    text: selected
      .map((segment) => segment.content.trim())
      .filter((line) => line.length > 0)
      .slice(0, 2)
      .join(' '),
    sources: normalizeNoteSources(
      selected.map((segment) => ({
        startMs: segment.sourceStartMs,
        endMs: segment.sourceEndMs
      }))
    ),
    provenance: 'generated'
  }
}

function pickDiverse(
  ranked: ReadonlyArray<{ segment: Segment; index: number }>,
  limit: number
): Segment[] {
  const selected: Segment[] = []
  const selectedIds = new Set<string>()
  const selectedTopics = new Set<string>()
  for (const row of ranked) {
    const topic = row.segment.topic?.trim().toLocaleLowerCase() ?? ''
    if (!topic || topic === OTHER_NOTES_TOPIC.toLocaleLowerCase() || selectedTopics.has(topic)) {
      continue
    }
    selected.push(row.segment)
    selectedIds.add(row.segment.id)
    selectedTopics.add(topic)
    if (selected.length >= limit) return selected
  }
  for (const row of ranked) {
    if (selectedIds.has(row.segment.id)) continue
    selected.push(row.segment)
    selectedIds.add(row.segment.id)
    if (selected.length >= limit) break
  }
  return selected
}

function rankSegments(
  segments: MeetingSegments,
  predicate: (segment: Segment) => boolean
): Array<{ segment: Segment; index: number; score: number }> {
  return Object.values(segments)
    .flat()
    .filter(predicate)
    .map((segment, index) => ({ segment, index, score: summaryScore(segment) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.segment.sourceStartMs - right.segment.sourceStartMs ||
        left.index - right.index
    )
}

function lastReleaseSummarySegments(segments: MeetingSegments): Segment[] {
  const ranked = Object.values(segments)
    .flat()
    .filter((segment) => noteTextLooksCoherent(segment.content))
    .map((segment, index) => ({ segment, index, score: summaryScore(segment) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.segment.sourceStartMs - right.segment.sourceStartMs ||
        left.index - right.index
    )
  const selected: Segment[] = []
  const selectedIds = new Set<string>()
  const selectedTopics = new Set<string>()
  for (const row of ranked) {
    const topic = row.segment.topic?.trim().toLocaleLowerCase() ?? ''
    if (!topic || selectedTopics.has(topic)) continue
    selected.push(row.segment)
    selectedIds.add(row.segment.id)
    selectedTopics.add(topic)
    if (selected.length >= 4) return selected
  }
  for (const row of ranked) {
    if (selectedIds.has(row.segment.id)) continue
    selected.push(row.segment)
    selectedIds.add(row.segment.id)
    if (selected.length >= 4) break
  }
  return selected
}

function summarySegments(segments: MeetingSegments): Segment[] {
  if (isWindowsTopicWriterEnabled()) return []
  if (!isWindowsNotesQualityEnabled()) return lastReleaseSummarySegments(segments)
  return pickDiverse(rankSegments(segments, isPromotable), 4)
}

function overviewSegments(segments: MeetingSegments, selectedSummary?: Segment[]): Segment[] {
  if (!isWindowsNotesQualityEnabled()) {
    // On Mac the overview is the first item in the very same ranked summary.
    // Reuse that local result instead of repeating coherence checks and ranking.
    const first = (process.platform === 'darwin' && selectedSummary
      ? selectedSummary
      : lastReleaseSummarySegments(segments))[0]
    return first ? [first] : []
  }
  const preferred = pickDiverse(rankSegments(segments, isOverviewCandidate), 2)
  if (preferred.length > 0) return preferred
  return pickDiverse(rankSegments(segments, isPromotable), 2)
}

export function countContextDependentRejections(segments: MeetingSegments): number {
  return Object.values(segments)
    .flat()
    .filter((segment) => noteTextLooksCoherent(segment.content))
    .filter((segment) => !isPromotable(segment)).length
}

function takeawayHeading(segment: Segment): string {
  if (!isWindowsNotesQualityEnabled()) return segment.title
  return (
    distinctNoteTitle(segment.title, segment.content, {
      topic: segment.topic,
      sectionTitle: segment.topic
    }) ?? ''
  )
}

function takeawayId(meetingId: string, segment: Segment, index: number): string {
  return `lossless-takeaway:${createHash('sha256')
    .update(meetingId)
    .update('\0')
    .update(segment.id)
    .update('\0')
    .update(String(index))
    .digest('hex')
    .slice(0, 16)}`
}

function withSummaryHierarchy(
  meetingId: string,
  segments: MeetingSegments,
  content: MeetingNotesContent
): MeetingNotesContent {
  const selected = summarySegments(segments)
  const takeaways = isWindowsNotesQualityEnabled() ? selected : selected.slice(1)
  return {
    ...content,
    overview: composeOverview(overviewSegments(segments, selected)),
    keyTakeaways: takeaways.map((segment, index) => ({
      id: takeawayId(meetingId, segment, index),
      title: takeawayHeading(segment),
      topic: segment.topic,
      owner: null,
      deadline: null,
      text: segment.content,
      sources: [{ startMs: segment.sourceStartMs, endMs: segment.sourceEndMs }],
      provenance: 'generated',
      completed: false
    }))
  }
}

function compareSectionGroups(
  left: { title?: string; segments: readonly Segment[]; index: number },
  right: { title?: string; segments: readonly Segment[]; index: number }
): number {
  if (isWindowsNotesQualityEnabled()) {
    const leftOther = isOtherNotesTopic(left.title) || isOtherNotesTopic(left.segments[0]?.topic)
    const rightOther = isOtherNotesTopic(right.title) || isOtherNotesTopic(right.segments[0]?.topic)
    if (leftOther !== rightOther) return leftOther ? 1 : -1
  }
  const leftFirst = left.segments[0]
  const rightFirst = right.segments[0]
  if (!leftFirst || !rightFirst) return left.index - right.index
  return (
    leftFirst.sourceStartMs - rightFirst.sourceStartMs ||
    leftFirst.sourceEndMs - rightFirst.sourceEndMs ||
    left.index - right.index
  )
}

function sectionKind(section: Pick<NoteSection, 'id'>): SectionKind | null {
  const match = LOSSLESS_SECTION_ID.exec(section.id)
  return (match?.[1] as SectionKind | undefined) ?? null
}

function createSectionIdAllocator(
  meetingId: string,
  segments: MeetingSegments
): {
  allocate(kind: SectionKind, groupKey: string, index: number): string
} {
  const used = new Set(expectedItems(segments).map(({ segment }) => segment.id))
  return {
    allocate(kind, groupKey, index) {
      const digest = createHash('sha256')
        .update(meetingId)
        .update('\0')
        .update(kind)
        .update('\0')
        .update(groupKey)
        .update('\0')
        .update(String(index))
        .digest('hex')
        .slice(0, 16)
      const base = `lossless-section:${kind}:${digest}`
      let id = base
      let suffix = 1
      while (used.has(id)) {
        id = `${base}:${suffix}`
        suffix += 1
      }
      used.add(id)
      return id
    }
  }
}

function makeSection(id: string, title: string, segments: readonly Segment[]): NoteSection {
  return {
    id,
    title,
    summary: null,
    keyPoints: segments.map(toNoteItem),
    supportingDetails: []
  }
}

function buildGroupedSections(meetingId: string, segments: MeetingSegments): NoteSection[] {
  if (process.platform === 'darwin') return buildSubjectSections(meetingId, segments)
  const ids = createSectionIdAllocator(meetingId, segments)
  const groups = new Map<string, { kind: SectionKind; title: string; segments: Segment[] }>()

  for (const { key, category, fallbackTitle } of SECTION_BUCKETS) {
    for (const segment of segments[key]) {
      const topic = segment.topic?.trim() ?? ''
      const kind: SectionKind = topic ? 'topical' : category
      const groupKey = topic ? `topic:${topic}` : `ungrouped:${category}`
      const existing = groups.get(groupKey)
      if (existing) {
        existing.segments.push(segment)
      } else {
        groups.set(groupKey, {
          kind,
          title: topic || fallbackTitle,
          segments: [segment]
        })
      }
    }
  }

  return [...groups.entries()]
    .map(([groupKey, group], index) => ({
      ...group,
      groupKey,
      index,
      segments: stableSortSegments(group.segments)
    }))
    .sort(compareSectionGroups)
    .map((group) =>
      makeSection(
        ids.allocate(group.kind, group.groupKey, group.index),
        group.title,
        group.segments
      )
    )
}

/** Decisions belong with their subject. Untitled records stay visible without a bucket name. */
function buildSubjectSections(meetingId: string, segments: MeetingSegments): NoteSection[] {
  const ids = createSectionIdAllocator(meetingId, segments)
  const groups = new Map<string, { title: string; segments: Segment[]; index: number }>()
  const body = stableSortSegments([
    ...segments.information,
    ...segments.discussion,
    ...segments.statusUpdates,
    ...segments.decisions
  ])
  for (const segment of body) {
    const title = segment.topic?.replace(/\s+/gu, ' ').trim() ?? ''
    const key = title ? `topic:${title.toLocaleLowerCase()}` : `unassigned:${segment.id}`
    const existing = groups.get(key)
    if (existing) existing.segments.push(segment)
    else groups.set(key, { title, segments: [segment], index: groups.size })
  }
  return [...groups.entries()].map(([key, group]) =>
    makeSection(ids.allocate('topical', key, group.index), group.title, group.segments)
  )
}

function buildDirectFallback(
  meetingId: string,
  segments: MeetingSegments,
  options: LosslessPresentationOptions
): MeetingNotesContent {
  if (process.platform === 'darwin') return buildGroupedCandidate(meetingId, segments, options)
  const ids = createSectionIdAllocator(meetingId, segments)
  const sectionGroups: Array<{
    category: SectionCategory
    fallbackTitle: string
    segments: Segment[]
    index: number
  }> = []

  for (const [index, { key, category, fallbackTitle }] of SECTION_BUCKETS.entries()) {
    if (segments[key].length === 0) continue
    sectionGroups.push({
      category,
      fallbackTitle,
      segments: stableSortSegments(segments[key]),
      index
    })
  }

  const sections = sectionGroups
    .sort(compareSectionGroups)
    .map((group) =>
      makeSection(
        ids.allocate(group.category, `direct:${group.category}`, group.index),
        group.fallbackTitle,
        group.segments
      )
    )

  return withSummaryHierarchy(meetingId, options.summarySegments ?? segments, {
    overview: null,
    keyTakeaways: [],
    sections,
    decisions: stableSortSegments(segments.decisions).map(toNoteItem),
    nextSteps: stableSortSegments(segments.actionItems).map(toNoteItem)
  })
}

function buildGroupedCandidate(
  meetingId: string,
  segments: MeetingSegments,
  options: LosslessPresentationOptions
): MeetingNotesContent {
  return withSummaryHierarchy(meetingId, options.summarySegments ?? segments, {
    overview: null,
    keyTakeaways: [],
    sections: buildGroupedSections(meetingId, segments),
    decisions:
      process.platform === 'darwin' ? [] : stableSortSegments(segments.decisions).map(toNoteItem),
    nextSteps: stableSortSegments(segments.actionItems).map(toNoteItem)
  })
}

function presentedItems(content: MeetingNotesContent): PresentedItem[] {
  const presented: PresentedItem[] = [
    ...content.decisions.map((item) => ({ item, location: 'decision' as const })),
    ...content.nextSteps.map((item) => ({ item, location: 'next-step' as const }))
  ]

  for (const section of content.sections) {
    const location = sectionKind(section) === null ? null : ('section' as const)
    for (const item of [...section.keyPoints, ...section.supportingDetails]) {
      presented.push({ item, location })
    }
  }
  return presented
}

function sourceMatchesSegment(sources: NoteItem['sources'], segment: Segment): boolean {
  return (
    sources.length === 1 &&
    sources[0]?.startMs === segment.sourceStartMs &&
    sources[0]?.endMs === segment.sourceEndMs
  )
}

function overviewSourcesMatch(sources: NoteItem['sources'], selected: readonly Segment[]): boolean {
  const expected = normalizeNoteSources(
    selected.map((segment) => ({
      startMs: segment.sourceStartMs,
      endMs: segment.sourceEndMs
    }))
  )
  if (sources.length !== expected.length) return false
  return expected.every(
    (source, index) =>
      sources[index]?.startMs === source.startMs && sources[index]?.endMs === source.endMs
  )
}

function presentedTopicMatches(
  itemTopic: string | null | undefined,
  segmentTopic: string | null | undefined
): boolean {
  const expected = segmentTopic?.trim() ?? ''
  const actual = itemTopic?.trim() ?? ''
  if (expected) return actual === expected
  return true
}

function hasSourceBackedSummaryHierarchy(
  segments: MeetingSegments,
  content: MeetingNotesContent
): boolean {
  const expected = summarySegments(segments)
  const overviewExpected = overviewSegments(segments, expected)
  const overview = composeOverview(overviewExpected)
  if (!overview) return content.overview === null && content.keyTakeaways.length === 0
  if (
    content.overview?.text !== overview.text ||
    content.overview.provenance !== 'generated' ||
    !(isWindowsNotesQualityEnabled()
      ? overviewSourcesMatch(content.overview.sources, overviewExpected)
      : sourceMatchesSegment(content.overview.sources, overviewExpected[0]!))
  ) {
    return false
  }

  const expectedTakeaways = isWindowsNotesQualityEnabled() ? expected : expected.slice(1)
  if (content.keyTakeaways.length !== expectedTakeaways.length) return false
  return content.keyTakeaways.every((item, index) => {
    const segment = expectedTakeaways[index]
    return (
      segment !== undefined &&
      DERIVED_TAKEAWAY_ID.test(item.id) &&
      item.title === takeawayHeading(segment) &&
      (isWindowsNotesQualityEnabled()
        ? presentedTopicMatches(item.topic, segment.topic)
        : item.topic === segment.topic) &&
      item.owner === null &&
      item.deadline === null &&
      item.text === segment.content &&
      item.provenance === 'generated' &&
      item.completed !== true &&
      sourceMatchesSegment(item.sources, segment)
    )
  })
}

/** A separate highlight catalog may differ in topics, never in factual content. */
function hasCompatibleSummaryCatalog(segments: MeetingSegments, summary: MeetingSegments): boolean {
  const records = Object.values(segments).flat()
  const originals = new Map(records.map((segment) => [segment.id, segment]))
  const highlights = Object.values(summary).flat()
  if (
    highlights.length !== records.length ||
    new Set(highlights.map((row) => row.id)).size !== records.length
  ) {
    return false
  }
  return highlights.every((segment) => {
    const original = originals.get(segment.id)
    return (
      original !== undefined &&
      segment.category === original.category &&
      segment.meetingId === original.meetingId &&
      itemMatchesSegment(toNoteItem({ ...segment, topic: original.topic }), original)
    )
  })
}

function itemMatchesSegment(item: NoteItem, segment: Segment): boolean {
  const source = item.sources[0]
  return (
    item.id === segment.id &&
    item.title === segment.title &&
    (isWindowsNotesQualityEnabled()
      ? presentedTopicMatches(item.topic, segment.topic)
      : item.topic === segment.topic) &&
    item.owner === segment.assignee &&
    item.deadline === segment.deadline &&
    item.text === segment.content &&
    item.provenance === 'generated' &&
    item.completed !== true &&
    item.sources.length === 1 &&
    source?.startMs === segment.sourceStartMs &&
    source.endMs === segment.sourceEndMs
  )
}

/**
 * Verifies a one-to-one, field-exact projection of writer segments. All three
 * non-footer categories share the same structured V2 section location.
 */
export function presentationSegments(segments: MeetingSegments): MeetingSegments {
  if (isWindowsTopicWriterEnabled()) return assignWindowsPresentationTopics(segments)
  if (isWindowsNotesQualityEnabled()) return assignPresentationTopics(segments)
  return segments
}

export function losslessPresentationStats(
  segments: MeetingSegments,
  content: MeetingNotesContent
): LosslessPresentationStats {
  const presented = presentationSegments(segments)
  const bodyRecords = [
    ...(process.platform === 'darwin' ? presented.decisions : []),
    ...presented.information,
    ...presented.discussion,
    ...presented.statusUpdates
  ]
  const topical = bodyRecords.filter((segment) => {
    const topic = segment.topic?.trim() ?? ''
    return topic.length > 0 && topic !== OTHER_NOTES_TOPIC && topic !== NEEDS_REVIEW_TOPIC
  }).length
  const genericSections = content.sections.filter((section) =>
    GENERIC_SECTION_TITLES.has(section.title.trim())
  ).length
  const needsReviewCount = Object.values(presented)
    .flat()
    .filter((segment) => segment.topic?.trim() === NEEDS_REVIEW_TOPIC).length
  return {
    topicCoveragePercent:
      bodyRecords.length === 0 ? 100 : Math.round((100 * topical) / bodyRecords.length),
    genericHeadingPercent:
      content.sections.length === 0
        ? 0
        : Math.round((100 * genericSections) / content.sections.length),
    needsReviewCount,
    contextDependentRejected: countContextDependentRejections(presented),
    groupingFallback:
      content.sections.length > 0 &&
      content.sections.every(
        (section) =>
          GENERIC_SECTION_TITLES.has(section.title.trim()) ||
          section.title.trim() === OTHER_NOTES_TOPIC
      )
  }
}

export function hasExactLosslessCoverage(
  segments: MeetingSegments,
  content: MeetingNotesContent,
  options: LosslessPresentationOptions = {}
): boolean {
  segments = presentationSegments(segments)
  if (options.summarySegments && !hasCompatibleSummaryCatalog(segments, options.summarySegments)) {
    return false
  }
  if (!hasSourceBackedSummaryHierarchy(options.summarySegments ?? segments, content)) return false
  if (
    content.sections.some(
      (section) =>
        section.summary !== null ||
        sectionKind(section) === null ||
        section.keyPoints.length + section.supportingDetails.length === 0
    )
  ) {
    return false
  }

  const expected = expectedItems(segments)
  const expectedById = new Map(expected.map((row) => [row.segment.id, row]))
  if (expectedById.size !== expected.length) return false

  const actual = presentedItems(content)
  if (actual.length !== expected.length) return false
  const seen = new Set<string>()
  for (const row of actual) {
    if (seen.has(row.item.id)) return false
    seen.add(row.item.id)
    const source = expectedById.get(row.item.id)
    if (!source || source.location !== row.location) return false
    if (!itemMatchesSegment(row.item, source.segment)) return false
  }
  return seen.size === expectedById.size
}

/**
 * Accepts a candidate only when it is schema-valid and exactly covers the
 * writer catalog. Otherwise it returns a category-only direct projection.
 */
export function ensureExactLosslessCoverage(
  meetingId: string,
  segments: MeetingSegments,
  candidate: MeetingNotesContent,
  options: LosslessPresentationOptions = {}
): MeetingNotesContent {
  segments = presentationSegments(segments)
  validateInput(meetingId, segments)
  if (options.summarySegments && !hasCompatibleSummaryCatalog(segments, options.summarySegments)) {
    throw new LosslessPresenterError('incompatible-summary-catalog')
  }

  try {
    const parsed = parseMeetingNotesContent(candidate)
    if (hasExactLosslessCoverage(segments, parsed, options)) return parsed
  } catch {
    // The direct fallback below is the authoritative fail-closed path.
  }

  try {
    const fallback = parseMeetingNotesContent(buildDirectFallback(meetingId, segments, options))
    if (hasExactLosslessCoverage(segments, fallback, options)) return fallback
  } catch {
    // Convert schema/capacity failures into one content-free presenter error.
  }
  throw new LosslessPresenterError('coverage-fallback-failed')
}

/**
 * Pure, model-free projection from writer segments to persisted Notes V2
 * content. Callers choose explicitly when this replaces the legacy scan.
 */
export function presentMeetingSegmentsLosslessly(
  meetingId: string,
  segments: MeetingSegments,
  options: LosslessPresentationOptions = {}
): MeetingNotesContent {
  validateInput(meetingId, segments)
  const presented = presentationSegments(segments)
  return ensureExactLosslessCoverage(
    meetingId,
    presented,
    buildGroupedCandidate(meetingId, presented, options),
    options
  )
}
