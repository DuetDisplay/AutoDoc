import { createHash } from 'crypto'
import type {
  LegacyNotesRevision,
  MeetingNotesContent,
  MeetingNotesV2,
  NotesAttributionRevision,
  NoteItem,
  NoteSection,
  NoteSourceRange,
  NoteTextBlock,
  NotesRevision,
  TranscriptRevision
} from '../../shared/types'

export class NotesCanonicalizationError extends Error {
  constructor() {
    super('Notes contain a value that cannot be revisioned')
    this.name = 'NotesCanonicalizationError'
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new NotesCanonicalizationError()
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new NotesCanonicalizationError()
  }

  if (ancestors.has(value)) throw new NotesCanonicalizationError()
  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      const entries: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new NotesCanonicalizationError()
        entries.push(canonicalize(value[index], ancestors))
      }
      return `[${entries.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NotesCanonicalizationError()
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new NotesCanonicalizationError()

    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set())
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex')
}

/**
 * Canonical persisted order: chronological with only exact duplicates removed.
 * Adjacent and overlapping ranges intentionally remain separate evidence.
 */
export function normalizeNoteSources(sources: readonly NoteSourceRange[]): NoteSourceRange[] {
  const ordered = sources
    .map(({ startMs, endMs }) => ({ startMs, endMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)

  return ordered.filter(
    (source, index) =>
      index === 0 ||
      source.startMs !== ordered[index - 1].startMs ||
      source.endMs !== ordered[index - 1].endMs
  )
}

function normalizeTextBlockSources(block: NoteTextBlock): NoteTextBlock {
  return { ...block, sources: normalizeNoteSources(block.sources) }
}

function normalizeItemSources(item: NoteItem): NoteItem {
  return { ...item, sources: normalizeNoteSources(item.sources) }
}

function normalizeSectionSources(section: NoteSection): NoteSection {
  return {
    ...section,
    summary: section.summary === null ? null : normalizeTextBlockSources(section.summary),
    keyPoints: section.keyPoints.map(normalizeItemSources),
    supportingDetails: section.supportingDetails.map(normalizeItemSources)
  }
}

/** Creates the canonical content representation used by all V2 revisions. */
export function normalizeMeetingNotesContentSources(
  content: MeetingNotesContent
): MeetingNotesContent {
  return {
    overview: content.overview === null ? null : normalizeTextBlockSources(content.overview),
    keyTakeaways: content.keyTakeaways.map(normalizeItemSources),
    sections: content.sections.map(normalizeSectionSources),
    decisions: content.decisions.map(normalizeItemSources),
    nextSteps: content.nextSteps.map(normalizeItemSources)
  }
}

export function computeTranscriptRevision(
  meetingId: string,
  transcript: unknown
): TranscriptRevision {
  return `transcript-sha256:${sha256({ schemaVersion: 1, meetingId, transcript })}`
}

export function computeNotesAttributionRevision(
  meetingId: string,
  rows: readonly { id: string; confirmedSpeakerLabel?: string | null }[]
): NotesAttributionRevision {
  return `notes-attribution-sha256:${sha256({
    schemaVersion: 1,
    meetingId,
    labels: [...rows]
      .map((row) => ({ id: row.id, confirmedSpeakerLabel: row.confirmedSpeakerLabel ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })}`
}

export function computeNotesRevision(
  meetingId: string,
  sourceTranscriptRevision: TranscriptRevision,
  sourceAttributionRevision: NotesAttributionRevision,
  content: MeetingNotesContent
): NotesRevision {
  return `sha256:${sha256({
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision,
    sourceAttributionRevision,
    content: normalizeMeetingNotesContentSources(content)
  })}`
}

export function computeLegacyNotesRevision(
  meetingId: string,
  segments: unknown
): LegacyNotesRevision {
  return `legacy-sha256:${sha256({ adapterVersion: 1, meetingId, segments })}`
}

export function hasValidNotesRevision(notes: MeetingNotesV2): boolean {
  return (
    notes.revision ===
    computeNotesRevision(
      notes.meetingId,
      notes.sourceTranscriptRevision,
      notes.sourceAttributionRevision,
      {
        overview: notes.overview,
        keyTakeaways: notes.keyTakeaways,
        sections: notes.sections,
        decisions: notes.decisions,
        nextSteps: notes.nextSteps
      }
    )
  )
}
