import type {
  NormalizedNoteBlock,
  NormalizedNoteItem,
  NormalizedNotes,
  NotesAttributionRevision,
  NoteBlockLocation,
  NoteEvidenceStatus,
  NoteSourceRange,
  TranscriptRevision
} from '../../shared/types'

function copySources(sources: readonly NoteSourceRange[]): NoteSourceRange[] {
  return sources.map(({ startMs, endMs }) => ({ startMs, endMs }))
}

function getEvidenceStatus(
  notes: NormalizedNotes,
  currentTranscriptRevision: TranscriptRevision | null,
  currentAttributionRevision: NotesAttributionRevision | null
): NoteEvidenceStatus {
  if (notes.sourceTranscriptRevision === null) return 'unknown'
  if (
    (currentTranscriptRevision !== null &&
      notes.sourceTranscriptRevision !== currentTranscriptRevision) ||
    (currentAttributionRevision !== null &&
      notes.sourceAttributionRevision !== currentAttributionRevision)
  ) {
    return 'stale'
  }
  if (currentTranscriptRevision === null || currentAttributionRevision === null) return 'unknown'
  return 'current'
}

function projectItem(
  item: NormalizedNoteItem,
  location: Exclude<NoteBlockLocation, 'overview' | 'section-summary'>,
  notes: NormalizedNotes,
  evidenceStatus: NoteEvidenceStatus,
  sectionId: string | null,
  sectionTitle: string | null
): NormalizedNoteBlock {
  return {
    ref: { kind: 'item', itemId: item.id },
    revision: notes.revision,
    sourceTranscriptRevision: notes.sourceTranscriptRevision,
    sourceAttributionRevision: notes.sourceAttributionRevision,
    evidenceStatus,
    location,
    sectionId,
    sectionTitle,
    title: item.title,
    topic: item.topic,
    text: item.text,
    owner: item.owner,
    deadline: item.deadline,
    sources: copySources(item.sources),
    provenance: item.provenance,
    legacySource: item.legacySource === null ? null : { ...item.legacySource }
  }
}

/**
 * Projects every semantic note block into one consumer-safe, lossless sequence.
 * Pass the transcript revision currently loaded for the meeting to mark V2
 * evidence stale after retranscription, plus the current confirmed-attribution
 * revision to catch speaker relabeling. Missing current state never reports current.
 */
export function traverseNormalizedNotes(
  notes: NormalizedNotes,
  currentTranscriptRevision: TranscriptRevision | null,
  currentAttributionRevision: NotesAttributionRevision | null
): NormalizedNoteBlock[] {
  const evidenceStatus = getEvidenceStatus(
    notes,
    currentTranscriptRevision,
    currentAttributionRevision
  )
  const blocks: NormalizedNoteBlock[] = []

  if (notes.overview !== null) {
    blocks.push({
      ref: { kind: 'overview' },
      revision: notes.revision,
      sourceTranscriptRevision: notes.sourceTranscriptRevision,
      sourceAttributionRevision: notes.sourceAttributionRevision,
      evidenceStatus,
      location: 'overview',
      sectionId: null,
      sectionTitle: null,
      title: null,
      topic: null,
      text: notes.overview.text,
      owner: null,
      deadline: null,
      sources: copySources(notes.overview.sources),
      provenance: notes.overview.provenance,
      legacySource: null
    })
  }

  for (const item of notes.keyTakeaways) {
    blocks.push(projectItem(item, 'key-takeaway', notes, evidenceStatus, null, null))
  }

  for (const section of notes.sections) {
    if (section.summary !== null) {
      blocks.push({
        ref: { kind: 'section-summary', sectionId: section.id },
        revision: notes.revision,
        sourceTranscriptRevision: notes.sourceTranscriptRevision,
        sourceAttributionRevision: notes.sourceAttributionRevision,
        evidenceStatus,
        location: 'section-summary',
        sectionId: section.id,
        sectionTitle: section.title,
        title: null,
        topic: null,
        text: section.summary.text,
        owner: null,
        deadline: null,
        sources: copySources(section.summary.sources),
        provenance: section.summary.provenance,
        legacySource: null
      })
    }
    for (const item of section.keyPoints) {
      blocks.push(projectItem(item, 'key-point', notes, evidenceStatus, section.id, section.title))
    }
    for (const item of section.supportingDetails) {
      blocks.push(
        projectItem(item, 'supporting-detail', notes, evidenceStatus, section.id, section.title)
      )
    }
  }

  for (const item of notes.decisions) {
    blocks.push(projectItem(item, 'decision', notes, evidenceStatus, null, null))
  }
  for (const item of notes.nextSteps) {
    blocks.push(projectItem(item, 'next-step', notes, evidenceStatus, null, null))
  }

  return blocks
}
