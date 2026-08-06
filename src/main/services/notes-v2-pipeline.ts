import { createHash } from 'crypto'
import type {
  MeetingNotesContent,
  NoteEvidenceId,
  NoteItem,
  NoteSourceId,
  NotesAttributionRevision,
  Transcript,
  TranscriptRevision
} from '../../shared/types'
import { parseMeetingNotesContent } from './notes-schema'
import { computeNotesAttributionRevision, computeTranscriptRevision } from './notes-revision'
import type {
  NotesEvidenceAttribution,
  NotesEvidenceClaim,
  NotesInferenceClient,
  NotesMappedClaim,
  NotesReduceResult,
  NotesRuntimeProfile,
  NotesTranscriptAnchor,
  NotesTranscriptChunk
} from './notes-inference-client'
import {
  NotesPipelineError,
  resolveEvidenceSources,
  validateMappedClaims,
  validateNotesRuntimeProfile,
  validateReconciliation,
  validateReducerOutput,
  validateTranscriptAnchors
} from './notes-v2-validation'

export interface NotesTranscriptRow extends Transcript {
  confirmedSpeakerLabel?: string | null
}

export interface NotesPipelineInput {
  meetingId: string
  transcriptRows: readonly NotesTranscriptRow[]
  profile: NotesRuntimeProfile
  /** Row-count chunking is intentional: it preserves complete source anchors. */
  maxAnchorsPerChunk?: number
  /** Only incomplete responses retry; transport and validation errors remain visible. */
  maxAttempts?: number
}

export interface NotesPipelineStageMetric {
  stage: 'map' | 'reconcile' | 'reduce'
  durationMs: number
  calls: number
  retries: number
  inputTokens: number
  outputTokens: number
}

/** Content-free metrics suitable for the eval harness and production diagnostics. */
export interface NotesPipelineMetrics {
  anchors: number
  chunks: number
  mapClaims: number
  reconciledGroups: number
  mapMaxConcurrency: number
  stages: readonly NotesPipelineStageMetric[]
}

export interface NotesPipelineResult {
  content: MeetingNotesContent
  sourceTranscriptRevision: TranscriptRevision
  /** Include this with sourceTranscriptRevision in any mapper/reducer cache key. */
  sourceAttributionRevision: NotesAttributionRevision
  metrics: NotesPipelineMetrics
}

const DEFAULT_MAX_ANCHORS_PER_CHUNK = 40
const DEFAULT_MAX_ATTEMPTS = 2
const MAX_ATTEMPTS = 3
const MAX_MEETING_ID_LENGTH = 200

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function cloneSourceIds(sourceIds: readonly NoteSourceId[]): NoteSourceId[] {
  return [...sourceIds].sort()
}

function sourceIdentity(
  meetingId: string,
  transcriptRevision: TranscriptRevision,
  rowId: string
): NoteSourceId {
  return `source:${hash({ meetingId, transcriptRevision, rowId })}`
}

function evidenceIdentity(
  meetingId: string,
  transcriptRevision: TranscriptRevision,
  claim: NotesMappedClaim
): NoteEvidenceId {
  return `evidence:${hash({
    meetingId,
    transcriptRevision,
    text: claim.text,
    sourceIds: cloneSourceIds(claim.sourceIds),
    modality: claim.modality,
    topic: claim.topic,
    salience: claim.salience,
    exactReferences: claim.exactReferences
      .map((reference) => ({
        kind: reference.kind,
        value: reference.value,
        evidenceSourceIds: cloneSourceIds(reference.evidenceSourceIds)
      }))
      .sort((left, right) =>
        `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)
      ),
    protectedSignals: [...claim.protectedSignals].sort(),
    owner: claim.owner,
    deadline: claim.deadline
  })}`
}

function blockIdentityBase(kind: string, value: unknown): string {
  return `${kind}:${hash({ kind, value })}`
}

/** Semantic fields and normalized ranges stay stable when evidence IDs or sibling order change. */
function createBlockIdentityAllocator(): (kind: string, value: unknown) => string {
  const occurrences = new Map<string, number>()
  return (kind, value) => {
    const base = blockIdentityBase(kind, value)
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)
    return occurrence === 1 ? base : `${base}:${occurrence}`
  }
}

function canonicalTranscriptRows(rows: readonly NotesTranscriptRow[]): Transcript[] {
  return rows
    .map(({ id, meetingId, speaker, text, startMs, endMs, confidence }) => ({
      id,
      meetingId,
      speaker,
      text,
      startMs,
      endMs,
      confidence
    }))
    .sort(
      (left, right) =>
        left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id)
    )
}

/** Stable anchors bind source identity to the meeting, transcript revision, and exact transcript row ID. */
export function createNotesTranscriptAnchors(
  meetingId: string,
  transcriptRevision: TranscriptRevision,
  rows: readonly NotesTranscriptRow[]
): NotesTranscriptAnchor[] {
  const anchors = rows
    .map((row) => ({
      sourceId: sourceIdentity(meetingId, transcriptRevision, row.id),
      rowId: row.id,
      meetingId: row.meetingId,
      startMs: row.startMs,
      endMs: row.endMs,
      speakerId: row.speaker,
      confirmedSpeakerLabel: row.confirmedSpeakerLabel ?? null,
      text: row.text
    }))
    .sort(
      (left, right) =>
        left.startMs - right.startMs ||
        left.endMs - right.endMs ||
        left.rowId.localeCompare(right.rowId)
    )
  validateTranscriptAnchors(meetingId, anchors)
  return anchors
}

export function chunkNotesTranscriptAnchors(
  anchors: readonly NotesTranscriptAnchor[],
  maxAnchorsPerChunk = DEFAULT_MAX_ANCHORS_PER_CHUNK
): NotesTranscriptChunk[] {
  if (!Number.isSafeInteger(maxAnchorsPerChunk) || maxAnchorsPerChunk < 1) {
    throw new NotesPipelineError('invalid-profile')
  }
  const chunks: NotesTranscriptChunk[] = []
  for (let start = 0; start < anchors.length; start += maxAnchorsPerChunk) {
    chunks.push({ index: chunks.length, anchors: anchors.slice(start, start + maxAnchorsPerChunk) })
  }
  return chunks
}

function mergeCandidates<T extends { value: string; evidenceSourceIds: readonly NoteSourceId[] }>(
  candidates: readonly T[]
): T {
  const first = candidates[0]
  return {
    ...first,
    evidenceSourceIds: [
      ...new Set(candidates.flatMap((candidate) => candidate.evidenceSourceIds))
    ].sort()
  }
}

function mergeExactReferences(
  claims: readonly NotesEvidenceClaim[]
): NotesEvidenceClaim['exactReferences'] {
  const references = new Map<string, NotesEvidenceClaim['exactReferences'][number][]>()
  for (const reference of claims.flatMap((claim) => claim.exactReferences)) {
    const key = JSON.stringify({ kind: reference.kind, value: reference.value })
    const group = references.get(key)
    if (group) group.push(reference)
    else references.set(key, [reference])
  }
  return [...references.values()]
    .map((duplicates) => ({
      ...duplicates[0],
      evidenceSourceIds: [
        ...new Set(duplicates.flatMap((reference) => reference.evidenceSourceIds))
      ].sort()
    }))
    .sort((left, right) =>
      `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)
    )
}

function mergeSourceAttributions(
  claims: readonly NotesEvidenceClaim[]
): NotesEvidenceAttribution[] {
  const attributions = new Map<NoteSourceId, NotesEvidenceAttribution>()
  for (const attribution of claims.flatMap((claim) => claim.sourceAttributions)) {
    const existing = attributions.get(attribution.sourceId)
    if (
      existing &&
      (existing.speakerId !== attribution.speakerId ||
        existing.confirmedSpeakerLabel !== attribution.confirmedSpeakerLabel)
    ) {
      throw new NotesPipelineError('invalid-evidence')
    }
    attributions.set(attribution.sourceId, { ...attribution })
  }
  return [...attributions.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )
}

/** Exact duplicate claims merge in code, while every distinct source range remains available. */
export function mergeExactEvidenceClaims(
  claims: readonly NotesEvidenceClaim[]
): NotesEvidenceClaim[] {
  const groups = new Map<string, NotesEvidenceClaim[]>()
  for (const claim of claims) {
    const key = JSON.stringify({
      text: claim.text,
      modality: claim.modality,
      topic: claim.topic,
      salience: claim.salience,
      exactReferences: claim.exactReferences
        .map(({ kind, value }) => ({ kind, value }))
        .sort((left, right) =>
          `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)
        ),
      protectedSignals: [...claim.protectedSignals].sort(),
      owner:
        claim.owner === null
          ? null
          : { value: claim.owner.value, explicit: claim.owner.isExplicitAssignment },
      deadline:
        claim.deadline === null
          ? null
          : { value: claim.deadline.value, explicit: claim.deadline.isExplicitDeadline }
    })
    const group = groups.get(key)
    if (group) group.push(claim)
    else groups.set(key, [claim])
  }

  return [...groups.values()].map((duplicates) => {
    const first = duplicates[0]
    return {
      ...first,
      sourceIds: [...new Set(duplicates.flatMap((claim) => claim.sourceIds))].sort(),
      sourceAttributions: mergeSourceAttributions(duplicates),
      exactReferences: mergeExactReferences(duplicates),
      protectedSignals: [...new Set(duplicates.flatMap((claim) => claim.protectedSignals))].sort(),
      owner:
        first.owner === null
          ? null
          : mergeCandidates(duplicates.map((claim) => claim.owner!).filter(Boolean)),
      deadline:
        first.deadline === null
          ? null
          : mergeCandidates(duplicates.map((claim) => claim.deadline!).filter(Boolean))
    }
  })
}

function assertAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new NotesPipelineError('invalid-profile')
  }
  return attempts
}

async function callComplete<T>(
  call: () => Promise<{
    complete: boolean
    value: T
    usage: { inputTokens: number; outputTokens: number }
  }>,
  profile: NotesRuntimeProfile,
  maxAttempts: number
): Promise<{
  value: T
  calls: number
  retries: number
  inputTokens: number
  outputTokens: number
}> {
  let inputTokens = 0
  let outputTokens = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await call()
    if (
      response === null ||
      typeof response !== 'object' ||
      typeof response.complete !== 'boolean' ||
      !response.usage ||
      !Number.isSafeInteger(response.usage.inputTokens) ||
      response.usage.inputTokens < 0 ||
      !Number.isSafeInteger(response.usage.outputTokens) ||
      response.usage.outputTokens < 0 ||
      response.usage.outputTokens > profile.maxOutputTokens
    ) {
      throw new NotesPipelineError('invalid-model-output')
    }
    inputTokens += response.usage.inputTokens
    outputTokens += response.usage.outputTokens
    if (response && response.complete === true) {
      return {
        value: response.value,
        calls: attempt,
        retries: attempt - 1,
        inputTokens,
        outputTokens
      }
    }
  }
  throw new NotesPipelineError('truncated-response')
}

async function mapChunks(
  client: NotesInferenceClient,
  profile: NotesRuntimeProfile,
  chunks: readonly NotesTranscriptChunk[],
  maxAttempts: number
): Promise<{
  claims: NotesEvidenceClaim[]
  calls: number
  retries: number
  inputTokens: number
  outputTokens: number
  maxConcurrency: number
}> {
  const results: NotesEvidenceClaim[][] = new Array(chunks.length)
  let cursor = 0
  let active = 0
  let maxConcurrency = 0
  let calls = 0
  let retries = 0
  let inputTokens = 0
  let outputTokens = 0
  const workers = Math.min(profile.allowedConcurrency, chunks.length)

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= chunks.length) return
      active += 1
      maxConcurrency = Math.max(maxConcurrency, active)
      try {
        const complete = await callComplete(
          () => client.map({ profile, chunk: chunks[index] }),
          profile,
          maxAttempts
        )
        calls += complete.calls
        retries += complete.retries
        inputTokens += complete.inputTokens
        outputTokens += complete.outputTokens
        const mapped = validateMappedClaims(
          complete.value,
          new Map(chunks[index].anchors.map((anchor) => [anchor.sourceId, anchor])),
          profile
        )
        results[index] = mapped.map((claim, claimIndex) => ({
          ...claim,
          sourceAttributions: claim.sourceIds.map((sourceId) => {
            const anchor = chunks[index].anchors.find(
              (candidate) => candidate.sourceId === sourceId
            )
            if (!anchor) throw new NotesPipelineError('unknown-source-id')
            return {
              sourceId,
              speakerId: anchor.speakerId,
              confirmedSpeakerLabel: anchor.confirmedSpeakerLabel
            }
          }),
          // Temporary IDs are replaced after exact duplicate source unions.
          id: `evidence:chunk-${chunks[index].index}-${claimIndex}` as NoteEvidenceId
        }))
      } finally {
        active -= 1
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))
  return { claims: results.flat(), calls, retries, inputTokens, outputTokens, maxConcurrency }
}

function assignCanonicalEvidenceIds(
  meetingId: string,
  transcriptRevision: TranscriptRevision,
  claims: readonly NotesEvidenceClaim[]
): NotesEvidenceClaim[] {
  const assigned = [...claims]
    .sort((left, right) => {
      const leftKey = JSON.stringify({ ...left, id: undefined, sourceAttributions: undefined })
      const rightKey = JSON.stringify({ ...right, id: undefined, sourceAttributions: undefined })
      return leftKey.localeCompare(rightKey)
    })
    .map((claim) => ({ ...claim, id: evidenceIdentity(meetingId, transcriptRevision, claim) }))
  if (new Set(assigned.map((claim) => claim.id)).size !== assigned.length) {
    throw new NotesPipelineError('invalid-evidence')
  }
  return assigned
}

function contentFromReducer(
  reduced: NotesReduceResult,
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): MeetingNotesContent {
  const allocateIdentity = createBlockIdentityAllocator()
  const textBlock = (block: NonNullable<NotesReduceResult['overview']>) => ({
    text: block.text,
    sources: resolveEvidenceSources(block.evidenceIds, evidence, anchors),
    provenance: 'generated' as const
  })
  const itemFields = (value: NotesReduceResult['keyTakeaways'][number]): Omit<NoteItem, 'id'> => ({
    title: value.title,
    topic: value.topic,
    owner: value.owner,
    deadline: value.deadline,
    text: value.text,
    sources: resolveEvidenceSources(value.evidenceIds, evidence, anchors),
    provenance: 'generated' as const
  })
  const item = (value: NotesReduceResult['keyTakeaways'][number], kind: string) => {
    const fields = itemFields(value)
    return { id: allocateIdentity(kind, fields), ...fields }
  }
  const itemIdentityFields = (value: NoteItem): Omit<NoteItem, 'id'> => ({
    title: value.title,
    topic: value.topic,
    owner: value.owner,
    deadline: value.deadline,
    text: value.text,
    sources: value.sources,
    provenance: value.provenance
  })
  return parseMeetingNotesContent({
    overview: reduced.overview === null ? null : textBlock(reduced.overview),
    keyTakeaways: reduced.keyTakeaways.map((value) => item(value, 'takeaway')),
    sections: reduced.sections.map((section) => {
      const summary = section.summary === null ? null : textBlock(section.summary)
      const keyPoints = section.keyPoints.map((value) => item(value, 'key-point'))
      const supportingDetails = section.supportingDetails.map((value) =>
        item(value, 'supporting-detail')
      )
      return {
        id: allocateIdentity('section', {
          title: section.title,
          summary,
          keyPoints: keyPoints.map(itemIdentityFields),
          supportingDetails: supportingDetails.map(itemIdentityFields)
        }),
        title: section.title,
        summary,
        keyPoints,
        supportingDetails
      }
    }),
    decisions: reduced.decisions.map((value) => item(value, 'decision')),
    nextSteps: reduced.nextSteps.map((value) => item(value, 'next-step'))
  })
}

export async function runNotesV2Pipeline(
  client: NotesInferenceClient,
  input: NotesPipelineInput
): Promise<NotesPipelineResult> {
  if (
    typeof input.meetingId !== 'string' ||
    input.meetingId.length === 0 ||
    input.meetingId.length > MAX_MEETING_ID_LENGTH
  ) {
    throw new NotesPipelineError('invalid-anchor')
  }
  validateNotesRuntimeProfile(input.profile)
  const maxAttempts = assertAttempts(input.maxAttempts)
  const sourceTranscriptRevision = computeTranscriptRevision(
    input.meetingId,
    canonicalTranscriptRows(input.transcriptRows)
  )
  const sourceAttributionRevision = computeNotesAttributionRevision(
    input.meetingId,
    input.transcriptRows
  )
  const anchors = createNotesTranscriptAnchors(
    input.meetingId,
    sourceTranscriptRevision,
    input.transcriptRows
  )
  const anchorMap = validateTranscriptAnchors(input.meetingId, anchors)
  const chunks = chunkNotesTranscriptAnchors(anchors, input.maxAnchorsPerChunk)

  const mapStartedAt = Date.now()
  const mapped = await mapChunks(client, input.profile, chunks, maxAttempts)
  const evidence = assignCanonicalEvidenceIds(
    input.meetingId,
    sourceTranscriptRevision,
    mergeExactEvidenceClaims(mapped.claims)
  )
  const mapDurationMs = Date.now() - mapStartedAt

  const reconcileStartedAt = Date.now()
  const reconciled = await callComplete(
    () => client.reconcile({ profile: input.profile, evidence }),
    input.profile,
    maxAttempts
  )
  const groups = validateReconciliation(reconciled.value, evidence, anchorMap, input.profile)
  const reconcileDurationMs = Date.now() - reconcileStartedAt

  const reduceStartedAt = Date.now()
  const reduced = await callComplete(
    () => client.reduce({ profile: input.profile, groups, evidence }),
    input.profile,
    maxAttempts
  )
  const validated = validateReducerOutput(reduced.value, evidence, anchorMap, input.profile)
  const reduceDurationMs = Date.now() - reduceStartedAt
  const content = contentFromReducer(
    validated,
    new Map(evidence.map((claim) => [claim.id, claim])),
    anchorMap
  )

  return {
    content,
    sourceTranscriptRevision,
    sourceAttributionRevision,
    metrics: {
      anchors: anchors.length,
      chunks: chunks.length,
      mapClaims: evidence.length,
      reconciledGroups: groups.length,
      mapMaxConcurrency: mapped.maxConcurrency,
      stages: [
        {
          stage: 'map',
          durationMs: mapDurationMs,
          calls: mapped.calls,
          retries: mapped.retries,
          inputTokens: mapped.inputTokens,
          outputTokens: mapped.outputTokens
        },
        {
          stage: 'reconcile',
          durationMs: reconcileDurationMs,
          calls: reconciled.calls,
          retries: reconciled.retries,
          inputTokens: reconciled.inputTokens,
          outputTokens: reconciled.outputTokens
        },
        {
          stage: 'reduce',
          durationMs: reduceDurationMs,
          calls: reduced.calls,
          retries: reduced.retries,
          inputTokens: reduced.inputTokens,
          outputTokens: reduced.outputTokens
        }
      ]
    }
  }
}
