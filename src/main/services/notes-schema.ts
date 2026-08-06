import type {
  MeetingNotesContent,
  MeetingNotesV2,
  NotesAttributionRevision,
  NoteItem,
  NoteSection,
  NoteSourceRange,
  NoteTextBlock,
  NotesRevision,
  PersistedNoteBlockProvenance,
  TranscriptRevision
} from '../../shared/types'
import { hasValidNotesRevision, normalizeNoteSources } from './notes-revision'

export const NOTES_JSON_MAX_BYTES = 64 * 1024 * 1024
export const NOTES_ENCRYPTED_MAX_BYTES = NOTES_JSON_MAX_BYTES + 32
export const NOTES_MEETING_ID_MAX_LENGTH = 200

const MAX_ID_LENGTH = 512
const MAX_TEXT_LENGTH = 4 * 1024 * 1024
const MAX_METADATA_LENGTH = 64 * 1024
const MAX_ITEMS_PER_COLLECTION = 20_000
const MAX_SECTIONS = 5_000
const MAX_SOURCES_PER_BLOCK = 20_000
const MAX_GLOBAL_IDS = 50_000
const MAX_TOTAL_SOURCES = 250_000

export type NotesSchemaErrorCode =
  | 'invalid-shape'
  | 'unsupported-schema'
  | 'meeting-mismatch'
  | 'revision-mismatch'

const ERROR_MESSAGES: Record<NotesSchemaErrorCode, string> = {
  'invalid-shape': 'Notes have an invalid structure',
  'unsupported-schema': 'Notes use an unsupported schema',
  'meeting-mismatch': 'Notes do not belong to this meeting',
  'revision-mismatch': 'Notes failed their integrity check'
}

export class NotesSchemaError extends Error {
  constructor(readonly code: NotesSchemaErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'NotesSchemaError'
  }
}

interface ValidationContext {
  ids: Set<string>
  totalUtf8Bytes: number
  totalSources: number
}

function createValidationContext(): ValidationContext {
  return { ids: new Set(), totalUtf8Bytes: 0, totalSources: 0 }
}

function invalid(): never {
  throw new NotesSchemaError('invalid-shape')
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  if (Object.getOwnPropertySymbols(value).length > 0) invalid()
  return value as Record<string, unknown>
}

function expectExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalid()
  }
}

function expectString(
  value: unknown,
  maxLength: number,
  context: ValidationContext,
  allowEmpty = true
): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (!allowEmpty && value.length === 0)
  ) {
    invalid()
  }
  context.totalUtf8Bytes += Buffer.byteLength(value, 'utf8')
  if (context.totalUtf8Bytes > NOTES_JSON_MAX_BYTES) invalid()
  return value
}

function expectNullableString(
  value: unknown,
  maxLength: number,
  context: ValidationContext
): string | null {
  return value === null ? null : expectString(value, maxLength, context)
}

function expectArray(value: unknown, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) invalid()
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid()
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.keys(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
  ) {
    invalid()
  }
  return value
}

function expectFiniteNonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid()
  return value
}

function registerId(value: unknown, context: ValidationContext): string {
  const id = expectString(value, MAX_ID_LENGTH, context, false)
  if (context.ids.has(id) || context.ids.size >= MAX_GLOBAL_IDS) invalid()
  context.ids.add(id)
  return id
}

function parseSourceRange(value: unknown): NoteSourceRange {
  const record = expectRecord(value)
  expectExactKeys(record, ['startMs', 'endMs'])
  const startMs = expectFiniteNonnegative(record.startMs)
  const endMs = expectFiniteNonnegative(record.endMs)
  if (endMs < startMs) invalid()
  return { startMs, endMs }
}

function parseSources(value: unknown, context: ValidationContext): NoteSourceRange[] {
  const sources = expectArray(value, MAX_SOURCES_PER_BLOCK)
  context.totalSources += sources.length
  if (context.totalSources > MAX_TOTAL_SOURCES) invalid()
  return normalizeNoteSources(sources.map(parseSourceRange))
}

function parseProvenance(value: unknown): PersistedNoteBlockProvenance {
  if (value === 'generated' || value === 'user-created' || value === 'user-edited') return value
  invalid()
}

function parseTextBlock(value: unknown, context: ValidationContext): NoteTextBlock {
  const record = expectRecord(value)
  expectExactKeys(record, ['text', 'sources', 'provenance'])
  const provenance = parseProvenance(record.provenance)
  const sources = parseSources(record.sources, context)
  if (provenance === 'generated' && sources.length === 0) invalid()
  return {
    text: expectString(record.text, MAX_TEXT_LENGTH, context),
    sources,
    provenance
  }
}

function parseNullableTextBlock(value: unknown, context: ValidationContext): NoteTextBlock | null {
  return value === null ? null : parseTextBlock(value, context)
}

function parseItem(value: unknown, context: ValidationContext): NoteItem {
  const record = expectRecord(value)
  expectExactKeys(record, [
    'id',
    'title',
    'topic',
    'owner',
    'deadline',
    'text',
    'sources',
    'provenance'
  ])
  const provenance = parseProvenance(record.provenance)
  const sources = parseSources(record.sources, context)
  if (provenance === 'generated' && sources.length === 0) invalid()
  return {
    id: registerId(record.id, context),
    title: expectNullableString(record.title, MAX_METADATA_LENGTH, context),
    topic: expectNullableString(record.topic, MAX_METADATA_LENGTH, context),
    owner: expectNullableString(record.owner, MAX_METADATA_LENGTH, context),
    deadline: expectNullableString(record.deadline, MAX_METADATA_LENGTH, context),
    text: expectString(record.text, MAX_TEXT_LENGTH, context),
    sources,
    provenance
  }
}

function parseItems(value: unknown, context: ValidationContext): NoteItem[] {
  return expectArray(value, MAX_ITEMS_PER_COLLECTION).map((item) => parseItem(item, context))
}

function parseSection(value: unknown, context: ValidationContext): NoteSection {
  const record = expectRecord(value)
  expectExactKeys(record, ['id', 'title', 'summary', 'keyPoints', 'supportingDetails'])
  return {
    id: registerId(record.id, context),
    title: expectString(record.title, MAX_METADATA_LENGTH, context),
    summary: parseNullableTextBlock(record.summary, context),
    keyPoints: parseItems(record.keyPoints, context),
    supportingDetails: parseItems(record.supportingDetails, context)
  }
}

function parseSections(value: unknown, context: ValidationContext): NoteSection[] {
  return expectArray(value, MAX_SECTIONS).map((section) => parseSection(section, context))
}

function parseContentRecord(
  record: Record<string, unknown>,
  context: ValidationContext
): MeetingNotesContent {
  expectExactKeys(record, ['overview', 'keyTakeaways', 'sections', 'decisions', 'nextSteps'])
  return {
    overview: parseNullableTextBlock(record.overview, context),
    keyTakeaways: parseItems(record.keyTakeaways, context),
    sections: parseSections(record.sections, context),
    decisions: parseItems(record.decisions, context),
    nextSteps: parseItems(record.nextSteps, context)
  }
}

export function parseMeetingNotesContent(value: unknown): MeetingNotesContent {
  return parseContentRecord(expectRecord(value), createValidationContext())
}

export function isNotesRevision(value: unknown): value is NotesRevision {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

export function isTranscriptRevision(value: unknown): value is TranscriptRevision {
  return typeof value === 'string' && /^transcript-sha256:[a-f0-9]{64}$/.test(value)
}

export function isNotesAttributionRevision(value: unknown): value is NotesAttributionRevision {
  return typeof value === 'string' && /^notes-attribution-sha256:[a-f0-9]{64}$/.test(value)
}

export function parseMeetingNotesV2(value: unknown, expectedMeetingId?: string): MeetingNotesV2 {
  const record = expectRecord(value)
  expectExactKeys(record, [
    'schemaVersion',
    'meetingId',
    'sourceTranscriptRevision',
    'sourceAttributionRevision',
    'revision',
    'overview',
    'keyTakeaways',
    'sections',
    'decisions',
    'nextSteps'
  ])

  if (record.schemaVersion !== 2) throw new NotesSchemaError('unsupported-schema')

  const context = createValidationContext()
  const meetingId = expectString(record.meetingId, NOTES_MEETING_ID_MAX_LENGTH, context, false)
  if (expectedMeetingId !== undefined && meetingId !== expectedMeetingId) {
    throw new NotesSchemaError('meeting-mismatch')
  }
  if (
    !isTranscriptRevision(record.sourceTranscriptRevision) ||
    !isNotesAttributionRevision(record.sourceAttributionRevision) ||
    !isNotesRevision(record.revision)
  ) {
    invalid()
  }

  const content = parseContentRecord(
    {
      overview: record.overview,
      keyTakeaways: record.keyTakeaways,
      sections: record.sections,
      decisions: record.decisions,
      nextSteps: record.nextSteps
    },
    context
  )
  const notes: MeetingNotesV2 = {
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision: record.sourceTranscriptRevision,
    sourceAttributionRevision: record.sourceAttributionRevision,
    revision: record.revision,
    ...content
  }

  if (!hasValidNotesRevision(notes)) throw new NotesSchemaError('revision-mismatch')
  return notes
}
