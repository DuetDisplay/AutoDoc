import type { NoteEvidenceId, NoteSourceId } from '../../shared/types'

/**
 * Notes execution is intentionally independent from transcription settings.
 * Production adapters select this profile from native capacity measurements.
 */
export interface NotesRuntimeProfile {
  model: string
  contextWindowTokens: number
  maxOutputTokens: number
  acceleration: 'cpu' | 'metal' | 'cuda' | 'directml' | 'unknown'
  memoryPressure: 'normal' | 'elevated' | 'critical'
  allowedConcurrency: number
}

export type NotesModality =
  | 'fact'
  | 'status'
  | 'proposal'
  | 'question'
  | 'example'
  | 'explicit-request'
  | 'decision-agreement'
  | 'commitment'

export type NotesSalience = 'low' | 'normal' | 'high'
export type NotesProtectedSignal = 'privacy' | 'security' | 'compliance' | 'outage' | 'deadline'
export type NotesExactReferenceKind = 'name' | 'number' | 'date' | 'amount' | 'url'

/** Literal details that must be copied from a cited transcript anchor, never reconstructed. */
export interface NotesExactReference {
  kind: NotesExactReferenceKind
  value: string
  evidenceSourceIds: readonly NoteSourceId[]
}

export interface NotesTranscriptAnchor {
  sourceId: NoteSourceId
  rowId: string
  meetingId: string
  startMs: number
  endMs: number
  speakerId: string
  confirmedSpeakerLabel: string | null
  text: string
}

export interface NotesTranscriptChunk {
  index: number
  anchors: readonly NotesTranscriptAnchor[]
}

export interface NotesOwnerCandidate {
  value: string
  evidenceSourceIds: readonly NoteSourceId[]
  isExplicitAssignment: boolean
}

export interface NotesDeadlineCandidate {
  value: string
  evidenceSourceIds: readonly NoteSourceId[]
  isExplicitDeadline: boolean
}

/** Mapper output contains anchors, never media timestamps. */
export interface NotesMappedClaim {
  text: string
  sourceIds: readonly NoteSourceId[]
  modality: NotesModality
  topic: string | null
  salience: NotesSalience
  exactReferences: readonly NotesExactReference[]
  protectedSignals: readonly NotesProtectedSignal[]
  owner: NotesOwnerCandidate | null
  deadline: NotesDeadlineCandidate | null
}

/** Code-enriched source identity available to reconcile/reduce; never model-authored. */
export interface NotesEvidenceAttribution {
  sourceId: NoteSourceId
  speakerId: string
  confirmedSpeakerLabel: string | null
}

export interface NotesEvidenceClaim extends NotesMappedClaim {
  id: NoteEvidenceId
  sourceAttributions: readonly NotesEvidenceAttribution[]
}

export interface NotesEvidenceGroup {
  id: string
  evidenceIds: readonly NoteEvidenceId[]
  primaryEvidenceId: NoteEvidenceId
}

export interface NotesReconcileRequest {
  profile: NotesRuntimeProfile
  evidence: readonly NotesEvidenceClaim[]
}

/** Reconciliation may group claims but may not manufacture or rewrite evidence. */
export interface NotesReconcileResult {
  groups: readonly {
    evidenceIds: readonly NoteEvidenceId[]
    primaryEvidenceId: NoteEvidenceId
  }[]
}

export interface NotesEvidenceRefBlock {
  text: string
  evidenceIds: readonly NoteEvidenceId[]
}

export interface NotesReducedItem extends NotesEvidenceRefBlock {
  title: string | null
  topic: string | null
  owner: string | null
  deadline: string | null
}

export interface NotesReducedSection {
  title: string
  summary: NotesEvidenceRefBlock | null
  keyPoints: readonly NotesReducedItem[]
  supportingDetails: readonly NotesReducedItem[]
}

/** Reducer output contains evidence references only; code assigns item/section IDs and ranges. */
export interface NotesReduceResult {
  overview: NotesEvidenceRefBlock | null
  keyTakeaways: readonly NotesReducedItem[]
  sections: readonly NotesReducedSection[]
  decisions: readonly NotesReducedItem[]
  nextSteps: readonly NotesReducedItem[]
}

export interface NotesInferenceResponse<T> {
  complete: boolean
  value: T
  usage: Readonly<{
    inputTokens: number
    outputTokens: number
  }>
}

/**
 * Pure boundary shared by the offline harness and production adapters. It owns
 * no prompt, process, platform, logging, or persistence policy.
 */
export interface NotesInferenceClient {
  map(
    request: Readonly<{
      profile: NotesRuntimeProfile
      chunk: NotesTranscriptChunk
    }>
  ): Promise<NotesInferenceResponse<readonly NotesMappedClaim[]>>
  reconcile(request: NotesReconcileRequest): Promise<NotesInferenceResponse<NotesReconcileResult>>
  reduce(
    request: Readonly<{
      profile: NotesRuntimeProfile
      groups: readonly NotesEvidenceGroup[]
      evidence: readonly NotesEvidenceClaim[]
    }>
  ): Promise<NotesInferenceResponse<NotesReduceResult>>
}
