import type {
  LegacySegmentOrigin,
  MeetingSegments,
  NormalizedNoteItem,
  NormalizedNotes,
  SegmentCategory
} from '../../shared/types'
import { computeLegacyNotesRevision } from './notes-revision'
import { NOTES_MEETING_ID_MAX_LENGTH } from './notes-schema'

const LEGACY_BUCKETS = [
  { key: 'decisions', category: 'decision' },
  { key: 'actionItems', category: 'action_item' },
  { key: 'information', category: 'information' },
  { key: 'discussion', category: 'discussion' },
  { key: 'statusUpdates', category: 'status_update' }
] as const satisfies ReadonlyArray<{
  key: keyof MeetingSegments
  category: SegmentCategory
}>

const SECTION_BUCKETS = [
  { key: 'information', ungroupedTitle: 'Information' },
  { key: 'discussion', ungroupedTitle: 'Discussion' },
  { key: 'statusUpdates', ungroupedTitle: 'Status Updates' }
] as const satisfies ReadonlyArray<{
  key: 'information' | 'discussion' | 'statusUpdates'
  ungroupedTitle: string
}>

const MAX_ITEMS_PER_BUCKET = 20_000
const MAX_ID_LENGTH = 512
const MAX_TEXT_LENGTH = 4 * 1024 * 1024
const MAX_METADATA_LENGTH = 64 * 1024
const SEGMENT_CATEGORIES = new Set<SegmentCategory>([
  'decision',
  'action_item',
  'information',
  'discussion',
  'status_update'
])
const LEGACY_SEGMENT_KEYS = new Set([
  'id',
  'meetingId',
  'category',
  'topic',
  'title',
  'content',
  'assignee',
  'deadline',
  'sourceStartMs',
  'sourceEndMs'
])

export type LegacyAdapterErrorCode = 'invalid-legacy-segments' | 'meeting-mismatch'
export type LegacyAdapterDiagnostic = {
  code: 'bucket-category-mismatch'
  bucket: keyof MeetingSegments
  category: SegmentCategory
}

const ERROR_MESSAGES: Record<LegacyAdapterErrorCode, string> = {
  'invalid-legacy-segments': 'Legacy notes have an invalid structure',
  'meeting-mismatch': 'Legacy notes do not belong to this meeting'
}

export class LegacySegmentsAdapterError extends Error {
  constructor(readonly code: LegacyAdapterErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'LegacySegmentsAdapterError'
  }
}

interface ParsedLegacySegment {
  id: string | null
  meetingId: string | null
  category: SegmentCategory
  topic: string | null
  title: string
  content: string
  assignee: string | null
  deadline: string | null
  sourceStartMs: number
  sourceEndMs: number
}

interface LegacyEntry {
  bucket: keyof MeetingSegments
  itemIndex: number
  segment: ParsedLegacySegment
  normalizedId: string
}

interface ParsedLegacySegments {
  decisions: ParsedLegacySegment[]
  actionItems: ParsedLegacySegment[]
  information: ParsedLegacySegment[]
  discussion: ParsedLegacySegment[]
  statusUpdates: ParsedLegacySegment[]
}

function invalid(): never {
  throw new LegacySegmentsAdapterError('invalid-legacy-segments')
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  if (Object.getOwnPropertySymbols(value).length > 0) invalid()
  return value as Record<string, unknown>
}

function expectString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) invalid()
  return value
}

function expectNullableString(value: unknown, maxLength: number): string | null {
  if (value === null) return null
  return expectString(value, maxLength)
}

function expectOptionalLegacyId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return expectString(value, MAX_ID_LENGTH)
}

function expectOptionalMeetingId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return expectString(value, NOTES_MEETING_ID_MAX_LENGTH)
}

function expectLegacyNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid()
  return value
}

function parseLegacySegment(value: unknown, expectedMeetingId: string): ParsedLegacySegment {
  const record = expectRecord(value)
  if (Object.keys(record).some((key) => !LEGACY_SEGMENT_KEYS.has(key))) invalid()
  const meetingId = expectOptionalMeetingId(record.meetingId)
  if (meetingId !== null && meetingId.length > 0 && meetingId !== expectedMeetingId) {
    throw new LegacySegmentsAdapterError('meeting-mismatch')
  }

  if (typeof record.category !== 'string' || !SEGMENT_CATEGORIES.has(record.category as never)) {
    invalid()
  }

  return {
    id: expectOptionalLegacyId(record.id),
    meetingId,
    category: record.category as SegmentCategory,
    topic: expectNullableString(record.topic, MAX_METADATA_LENGTH),
    title: expectString(record.title, MAX_METADATA_LENGTH),
    content: expectString(record.content, MAX_TEXT_LENGTH),
    assignee: expectNullableString(record.assignee, MAX_METADATA_LENGTH),
    deadline: expectNullableString(record.deadline, MAX_METADATA_LENGTH),
    sourceStartMs: expectLegacyNumber(record.sourceStartMs),
    sourceEndMs: expectLegacyNumber(record.sourceEndMs)
  }
}

function parseLegacyBucket(value: unknown, expectedMeetingId: string): ParsedLegacySegment[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS_PER_BUCKET) invalid()
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid()
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
  ) {
    invalid()
  }
  return value.map((segment) => parseLegacySegment(segment, expectedMeetingId))
}

function parseLegacySegments(value: unknown, expectedMeetingId: string): ParsedLegacySegments {
  const record = expectRecord(value)
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = LEGACY_BUCKETS.map(({ key }) => key).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    invalid()
  }

  return {
    decisions: parseLegacyBucket(record.decisions, expectedMeetingId),
    actionItems: parseLegacyBucket(record.actionItems, expectedMeetingId),
    information: parseLegacyBucket(record.information, expectedMeetingId),
    discussion: parseLegacyBucket(record.discussion, expectedMeetingId),
    statusUpdates: parseLegacyBucket(record.statusUpdates, expectedMeetingId)
  }
}

function allocateId(base: string, usedIds: Set<string>): string {
  let candidate = base
  let suffix = 1
  while (usedIds.has(candidate)) {
    candidate = `${base}:${suffix}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

function assignNormalizedIds(segments: ParsedLegacySegments): {
  entries: LegacyEntry[]
  usedIds: Set<string>
} {
  const idCounts = new Map<string, number>()
  for (const { key } of LEGACY_BUCKETS) {
    for (const segment of segments[key]) {
      if (segment.id) {
        idCounts.set(segment.id, (idCounts.get(segment.id) ?? 0) + 1)
      }
    }
  }

  const usedIds = new Set<string>()
  for (const id of idCounts.keys()) usedIds.add(id)

  const entries: LegacyEntry[] = []
  for (const { key } of LEGACY_BUCKETS) {
    segments[key].forEach((segment, itemIndex) => {
      const normalizedId =
        segment.id && idCounts.get(segment.id) === 1
          ? segment.id
          : allocateId(`legacy-item:${key}:${itemIndex}`, usedIds)
      entries.push({ bucket: key, itemIndex, segment, normalizedId })
    })
  }
  return { entries, usedIds }
}

function toNormalizedItem(entry: LegacyEntry): NormalizedNoteItem {
  const { segment } = entry
  const sources =
    segment.sourceStartMs === 0 && segment.sourceEndMs === 0
      ? []
      : [
          {
            startMs: Math.min(segment.sourceStartMs, segment.sourceEndMs),
            endMs: Math.max(segment.sourceStartMs, segment.sourceEndMs)
          }
        ]
  const legacySource: LegacySegmentOrigin = {
    adapterVersion: 1,
    bucket: entry.bucket,
    itemIndex: entry.itemIndex,
    segmentId: segment.id,
    meetingId: segment.meetingId,
    category: segment.category,
    topic: segment.topic,
    sourceStartMs: segment.sourceStartMs,
    sourceEndMs: segment.sourceEndMs
  }
  return {
    id: entry.normalizedId,
    title: segment.title,
    topic: segment.topic,
    owner: segment.assignee,
    deadline: segment.deadline,
    text: segment.content,
    sources,
    provenance: 'legacy',
    legacySource
  }
}

function buildSections(entries: LegacyEntry[], usedIds: Set<string>): NormalizedNotes['sections'] {
  const sections: NormalizedNotes['sections'] = []

  for (const { key, ungroupedTitle } of SECTION_BUCKETS) {
    const bucketEntries = entries.filter((entry) => entry.bucket === key)
    const topicGroups = new Map<string, NormalizedNoteItem[]>()
    const ungrouped: NormalizedNoteItem[] = []

    for (const entry of bucketEntries) {
      const item = toNormalizedItem(entry)
      if (!entry.segment.topic) {
        ungrouped.push(item)
        continue
      }
      const group = topicGroups.get(entry.segment.topic)
      if (group) {
        group.push(item)
      } else {
        topicGroups.set(entry.segment.topic, [item])
      }
    }

    let groupIndex = 0
    for (const [topic, keyPoints] of topicGroups) {
      sections.push({
        id: allocateId(`legacy-section:${key}:${groupIndex}`, usedIds),
        title: topic,
        summary: null,
        keyPoints,
        supportingDetails: []
      })
      groupIndex += 1
    }

    if (ungrouped.length > 0) {
      sections.push({
        id: allocateId(`legacy-section:${key}:ungrouped`, usedIds),
        title: ungroupedTitle,
        summary: null,
        keyPoints: ungrouped,
        supportingDetails: []
      })
    }
  }

  return sections
}

function reportBucketMismatches(
  entries: LegacyEntry[],
  onDiagnostic?: (diagnostic: LegacyAdapterDiagnostic) => void
): void {
  for (const entry of entries) {
    const expectedCategory = LEGACY_BUCKETS.find(({ key }) => key === entry.bucket)?.category
    if (expectedCategory === entry.segment.category) continue
    const diagnostic: LegacyAdapterDiagnostic = {
      code: 'bucket-category-mismatch',
      bucket: entry.bucket,
      category: entry.segment.category
    }
    if (onDiagnostic) {
      onDiagnostic(diagnostic)
    } else {
      console.warn('[notes] Legacy bucket/category mismatch', diagnostic)
    }
  }
}

export function adaptLegacySegments(
  meetingId: string,
  value: unknown,
  options: { onDiagnostic?: (diagnostic: LegacyAdapterDiagnostic) => void } = {}
): NormalizedNotes {
  const parsed = parseLegacySegments(value, meetingId)
  const { entries, usedIds } = assignNormalizedIds(parsed)
  reportBucketMismatches(entries, options.onDiagnostic)

  const decisions = entries.filter((entry) => entry.bucket === 'decisions').map(toNormalizedItem)
  const nextSteps = entries.filter((entry) => entry.bucket === 'actionItems').map(toNormalizedItem)

  return {
    normalizedSchemaVersion: 1,
    meetingId,
    source: { format: 'legacy-segments', adapterVersion: 1 },
    sourceTranscriptRevision: null,
    sourceAttributionRevision: null,
    revision: computeLegacyNotesRevision(meetingId, parsed),
    overview: null,
    keyTakeaways: [],
    sections: buildSections(entries, usedIds),
    decisions,
    nextSteps
  }
}
