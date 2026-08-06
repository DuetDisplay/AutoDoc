import type { NoteEvidenceId, NoteSourceId, NoteSourceRange } from '../../shared/types'
import { normalizeNoteSources } from './notes-revision'
import type {
  NotesDeadlineCandidate,
  NotesEvidenceClaim,
  NotesEvidenceGroup,
  NotesEvidenceRefBlock,
  NotesExactReference,
  NotesExactReferenceKind,
  NotesMappedClaim,
  NotesModality,
  NotesOwnerCandidate,
  NotesProtectedSignal,
  NotesReduceResult,
  NotesReducedItem,
  NotesRuntimeProfile,
  NotesSalience,
  NotesTranscriptAnchor
} from './notes-inference-client'

export type NotesPipelineErrorCode =
  | 'invalid-profile'
  | 'invalid-anchor'
  | 'invalid-model-output'
  | 'unknown-source-id'
  | 'unknown-evidence-id'
  | 'invalid-evidence'
  | 'invalid-reconciliation'
  | 'missing-evidence'
  | 'invalid-modality-promotion'
  | 'unsupported-owner'
  | 'unsupported-deadline'
  | 'truncated-response'
  | 'size-limit'

const ERROR_MESSAGES: Record<NotesPipelineErrorCode, string> = {
  'invalid-profile': 'Notes inference profile is invalid',
  'invalid-anchor': 'Transcript anchors are invalid',
  'invalid-model-output': 'Notes inference returned an invalid response',
  'unknown-source-id': 'Notes inference referenced an unknown source',
  'unknown-evidence-id': 'Notes inference referenced unknown evidence',
  'invalid-evidence': 'Notes inference returned invalid evidence',
  'invalid-reconciliation': 'Notes inference returned invalid reconciliation',
  'missing-evidence': 'Generated notes are missing evidence',
  'invalid-modality-promotion': 'Generated decision or next step lacks qualifying evidence',
  'unsupported-owner': 'Generated owner lacks explicit evidence',
  'unsupported-deadline': 'Generated deadline lacks explicit evidence',
  'truncated-response': 'Notes inference response was incomplete',
  'size-limit': 'Notes inference output exceeded its configured limit'
}

/** Errors intentionally contain no transcript, note, ID, path, or model content. */
export class NotesPipelineError extends Error {
  constructor(readonly code: NotesPipelineErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'NotesPipelineError'
  }
}

const MODALITIES = new Set<NotesModality>([
  'fact',
  'status',
  'proposal',
  'question',
  'example',
  'explicit-request',
  'decision-agreement',
  'commitment'
])
const SALIENCE = new Set<NotesSalience>(['low', 'normal', 'high'])
const PROTECTED_SIGNALS = new Set<NotesProtectedSignal>([
  'privacy',
  'security',
  'compliance',
  'outage',
  'deadline'
])
const EXACT_REFERENCE_KINDS = new Set<NotesExactReferenceKind>([
  'name',
  'number',
  'date',
  'amount',
  'url'
])
const ACCELERATION = new Set<NotesRuntimeProfile['acceleration']>([
  'cpu',
  'metal',
  'cuda',
  'directml',
  'unknown'
])
const MEMORY_PRESSURE = new Set<NotesRuntimeProfile['memoryPressure']>([
  'normal',
  'elevated',
  'critical'
])

const MAX_VALUE_LENGTH = 64 * 1024
const MAX_OUTPUT_BYTES_PER_TOKEN = 16
const MAX_CLAIMS = 10_000
const MAX_GROUPS = 10_000
const MAX_SECTIONS = 5_000
const MAX_ITEMS_PER_COLLECTION = 20_000
const MAX_EXACT_REFERENCES = 2_000
const MAX_PROTECTED_SIGNALS = 5

type CodeOwnedExactReferenceKind = Exclude<NotesExactReferenceKind, 'name'>

interface ExactLiteralMatch {
  kind: CodeOwnedExactReferenceKind
  value: string
  start: number
  end: number
}

const NUMERIC_BODY = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)*`
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu
const AMOUNT_PATTERN = new RegExp(
  String.raw`(?:[$€£¥]\s?${NUMERIC_BODY}(?:\s?[kmb])?|\b(?:USD|EUR|GBP|JPY)\s?${NUMERIC_BODY}|${NUMERIC_BODY}\s?(?:USD|EUR|GBP|JPY)\b)`,
  'giu'
)
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`
const DATE_PATTERN = new RegExp(
  String.raw`\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}\.?(?:\s+\d{4})?)\b`,
  'giu'
)
const NUMBER_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])[-+]?${NUMERIC_BODY}(?:\s?(?:%|percent(?:age\s+points?)?))?(?![\p{L}\p{N}_])`,
  'giu'
)

/**
 * Deliberately conservative keyword coverage for protected transcript anchors.
 * This is auditable recall protection, not semantic completeness or NER.
 */
const PROTECTED_SIGNAL_PATTERNS: Readonly<Record<NotesProtectedSignal, readonly RegExp[]>> = {
  privacy: [
    /\bprivacy\b/iu,
    /\bpersonal (?:data|information)\b/iu,
    /\bpersonally identifiable information\b/iu,
    /\bPII\b/u,
    /\bdata retention\b/iu
  ],
  security: [
    /\bsecurity\b/iu,
    /\bcredentials?\b/iu,
    /\bpasswords?\b/iu,
    /\bvulnerabilit(?:y|ies)\b/iu,
    /\bencrypt(?:ion|ed|ing)?\b/iu,
    /\bbreach\b/iu
  ],
  compliance: [
    /\bcompliance\b/iu,
    /\bregulatory\b/iu,
    /\bGDPR\b/u,
    /\bHIPAA\b/u,
    /\bSOC\s?2\b/iu,
    /\baudit requirements?\b/iu
  ],
  outage: [
    /\boutage\b/iu,
    /\bdowntime\b/iu,
    /\bincident\b/iu,
    /\bservice disruption\b/iu,
    /\bdegraded service\b/iu
  ],
  deadline: [
    /\bdeadline\b/iu,
    /\bdue (?:by|on|date)\b/iu,
    /\b(?:ship|launch|finish|complete) by\b/iu
  ]
}

function fail(code: NotesPipelineErrorCode): never {
  throw new NotesPipelineError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ensureExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid-model-output')
  }
}

function ensureString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_VALUE_LENGTH) {
    fail('invalid-model-output')
  }
  return value
}

function ensureNullableString(value: unknown): string | null {
  return value === null ? null : ensureString(value)
}

function ensureArray(value: unknown, maxLength = MAX_ITEMS_PER_COLLECTION): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) fail('invalid-model-output')
  return value
}

function ensureNoTimestampFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(ensureNoTimestampFields)
    return
  }
  if (!isRecord(value)) return
  if ('startMs' in value || 'endMs' in value) fail('invalid-model-output')
  Object.values(value).forEach(ensureNoTimestampFields)
}

function normalizeIds<T extends string>(ids: readonly T[], code: NotesPipelineErrorCode): T[] {
  if (ids.length === 0) fail(code)
  const unique = [...new Set(ids)]
  if (
    unique.length !== ids.length ||
    unique.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    fail(code)
  }
  return unique
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

function literalInEvidence(value: string, sourceText: string): boolean {
  const escaped = normalized(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(
    normalized(sourceText)
  )
}

function overlapsExistingMatch(
  start: number,
  end: number,
  matches: readonly ExactLiteralMatch[]
): boolean {
  return matches.some((match) => start < match.end && end > match.start)
}

function addPatternMatches(
  text: string,
  pattern: RegExp,
  kind: CodeOwnedExactReferenceKind,
  matches: ExactLiteralMatch[],
  trimUrlPunctuation = false
): void {
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    const value = trimUrlPunctuation ? match[0].replace(/[\])},.;!?]+$/u, '') : match[0]
    if (!value) continue
    const start = match.index
    const end = start + value.length
    if (overlapsExistingMatch(start, end, matches)) continue
    matches.push({ kind, value, start, end })
  }
}

/** Higher-precedence spans prevent numbers inside URLs, amounts, or dates from being counted twice. */
function detectExactLiterals(text: string): ExactLiteralMatch[] {
  const matches: ExactLiteralMatch[] = []
  addPatternMatches(text, URL_PATTERN, 'url', matches, true)
  addPatternMatches(text, AMOUNT_PATTERN, 'amount', matches)
  addPatternMatches(text, DATE_PATTERN, 'date', matches)
  addPatternMatches(text, NUMBER_PATTERN, 'number', matches)
  return matches.sort((left, right) => left.start - right.start || left.end - right.end)
}

function detectProtectedSignals(text: string): NotesProtectedSignal[] {
  return (Object.keys(PROTECTED_SIGNAL_PATTERNS) as NotesProtectedSignal[]).filter((signal) =>
    PROTECTED_SIGNAL_PATTERNS[signal].some((pattern) => pattern.test(text))
  )
}

function mergeExactReferences(references: readonly NotesExactReference[]): NotesExactReference[] {
  const merged = new Map<string, NotesExactReference>()
  for (const reference of references) {
    const key = `${reference.kind}\u0000${reference.value}`
    const existing = merged.get(key)
    merged.set(key, {
      kind: reference.kind,
      value: reference.value,
      evidenceSourceIds: [
        ...new Set([...(existing?.evidenceSourceIds ?? []), ...reference.evidenceSourceIds])
      ].sort()
    })
  }
  if (merged.size > MAX_EXACT_REFERENCES) fail('size-limit')
  return [...merged.values()].sort((left, right) =>
    `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)
  )
}

function detectGroundedExactReferences(
  text: string,
  sourceIds: readonly NoteSourceId[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesExactReference[] {
  return detectExactLiterals(text).map(({ kind, value }) => {
    const evidenceSourceIds = sourceIds.filter((sourceId) => {
      const anchor = anchors.get(sourceId)
      return anchor !== undefined && literalInEvidence(value, anchor.text)
    })
    if (evidenceSourceIds.length === 0) fail('invalid-evidence')
    return { kind, value, evidenceSourceIds: [...evidenceSourceIds].sort() }
  })
}

function candidateIsNamedInEvidence(
  value: string,
  sourceIds: readonly NoteSourceId[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): boolean {
  const target = normalized(value)
  return sourceIds.some((sourceId) => {
    const anchor = anchors.get(sourceId)
    if (!anchor) return false
    return (
      literalInEvidence(target, anchor.text) ||
      (anchor.confirmedSpeakerLabel !== null && normalized(anchor.confirmedSpeakerLabel) === target)
    )
  })
}

function parseExactReferences(
  value: unknown,
  sourceIds: readonly NoteSourceId[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesExactReference[] {
  return ensureArray(value, MAX_EXACT_REFERENCES).map((reference) => {
    if (!isRecord(reference)) fail('invalid-model-output')
    ensureExactKeys(reference, ['kind', 'value', 'evidenceSourceIds'])
    const kind = ensureString(reference.kind) as NotesExactReferenceKind
    const evidenceSourceIds = parseSourceIds(reference.evidenceSourceIds)
    const exact = { kind, value: ensureString(reference.value), evidenceSourceIds }
    if (
      !EXACT_REFERENCE_KINDS.has(kind) ||
      evidenceSourceIds.some((id) => !sourceIds.includes(id))
    ) {
      fail('invalid-evidence')
    }
    const isGrounded =
      kind === 'name'
        ? candidateIsNamedInEvidence(exact.value, evidenceSourceIds, anchors)
        : evidenceSourceIds.some((id) => literalInEvidence(exact.value, anchors.get(id)!.text))
    if (!isGrounded) fail('invalid-evidence')
    return exact
  })
}

function enrichProtectedClaims(
  claims: readonly NotesMappedClaim[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesMappedClaim[] {
  const enriched = claims.map((claim) => ({
    ...claim,
    protectedSignals: [...claim.protectedSignals]
  }))
  const claimSignals = claims.map((claim) => detectProtectedSignals(claim.text))

  for (const anchor of anchors.values()) {
    const anchorSignals = detectProtectedSignals(anchor.text)
    if (anchorSignals.length === 0) continue

    const citingClaimIndexes = claims.flatMap((claim, index) =>
      claim.sourceIds.includes(anchor.sourceId) ? [index] : []
    )
    if (citingClaimIndexes.length === 0) fail('missing-evidence')

    for (const signal of anchorSignals) {
      const selectedIndex =
        citingClaimIndexes.find((index) => claimSignals[index].includes(signal)) ??
        citingClaimIndexes[0]
      const selected = enriched[selectedIndex]
      selected.protectedSignals = [...new Set([...selected.protectedSignals, signal])].sort()
    }
  }

  return enriched
}

function parseProtectedSignals(value: unknown): NotesProtectedSignal[] {
  const signals = ensureArray(value, MAX_PROTECTED_SIGNALS).map(
    (signal) => ensureString(signal) as NotesProtectedSignal
  )
  if (
    new Set(signals).size !== signals.length ||
    signals.some((signal) => !PROTECTED_SIGNALS.has(signal))
  ) {
    fail('invalid-evidence')
  }
  return signals
}

function parseSourceIds(value: unknown): NoteSourceId[] {
  return normalizeIds(
    ensureArray(value).map((id) => ensureString(id) as NoteSourceId),
    'invalid-model-output'
  )
}

function parseOwner(
  value: unknown,
  sourceIds: readonly NoteSourceId[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesOwnerCandidate | null {
  if (value === null) return null
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['value', 'evidenceSourceIds', 'isExplicitAssignment'])
  const candidate = {
    value: ensureString(value.value),
    evidenceSourceIds: parseSourceIds(value.evidenceSourceIds).sort(),
    isExplicitAssignment: value.isExplicitAssignment === true
  }
  if (
    candidate.isExplicitAssignment !== true ||
    candidate.evidenceSourceIds.some((id) => !sourceIds.includes(id)) ||
    !candidateIsNamedInEvidence(candidate.value, candidate.evidenceSourceIds, anchors)
  ) {
    fail('unsupported-owner')
  }
  return candidate
}

function parseDeadline(
  value: unknown,
  sourceIds: readonly NoteSourceId[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesDeadlineCandidate | null {
  if (value === null) return null
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['value', 'evidenceSourceIds', 'isExplicitDeadline'])
  const candidate = {
    value: ensureString(value.value),
    evidenceSourceIds: parseSourceIds(value.evidenceSourceIds).sort(),
    isExplicitDeadline: value.isExplicitDeadline === true
  }
  if (
    candidate.isExplicitDeadline !== true ||
    candidate.evidenceSourceIds.some((id) => !sourceIds.includes(id)) ||
    !candidateIsNamedInEvidence(candidate.value, candidate.evidenceSourceIds, anchors)
  ) {
    fail('unsupported-deadline')
  }
  return candidate
}

export function validateNotesRuntimeProfile(profile: NotesRuntimeProfile): void {
  if (
    typeof profile.model !== 'string' ||
    profile.model.length === 0 ||
    !ACCELERATION.has(profile.acceleration) ||
    !MEMORY_PRESSURE.has(profile.memoryPressure) ||
    !Number.isSafeInteger(profile.contextWindowTokens) ||
    profile.contextWindowTokens < 1 ||
    !Number.isSafeInteger(profile.maxOutputTokens) ||
    profile.maxOutputTokens < 1 ||
    profile.maxOutputTokens > profile.contextWindowTokens ||
    !Number.isSafeInteger(profile.allowedConcurrency) ||
    profile.allowedConcurrency < 1 ||
    profile.allowedConcurrency > 16
  ) {
    fail('invalid-profile')
  }
}

export function validateTranscriptAnchors(
  meetingId: string,
  anchors: readonly NotesTranscriptAnchor[]
): Map<NoteSourceId, NotesTranscriptAnchor> {
  const sources = new Map<NoteSourceId, NotesTranscriptAnchor>()
  const rows = new Set<string>()
  for (const anchor of anchors) {
    if (
      anchor.meetingId !== meetingId ||
      typeof anchor.sourceId !== 'string' ||
      !/^source:[a-f0-9]{64}$/.test(anchor.sourceId) ||
      typeof anchor.rowId !== 'string' ||
      anchor.rowId.length === 0 ||
      rows.has(anchor.rowId) ||
      sources.has(anchor.sourceId) ||
      !Number.isSafeInteger(anchor.startMs) ||
      !Number.isSafeInteger(anchor.endMs) ||
      anchor.startMs < 0 ||
      anchor.endMs < anchor.startMs ||
      typeof anchor.speakerId !== 'string' ||
      anchor.speakerId.length === 0 ||
      typeof anchor.text !== 'string' ||
      (anchor.confirmedSpeakerLabel !== null && typeof anchor.confirmedSpeakerLabel !== 'string')
    ) {
      fail('invalid-anchor')
    }
    rows.add(anchor.rowId)
    sources.set(anchor.sourceId, { ...anchor })
  }
  return sources
}

export function validateMappedClaims(
  value: unknown,
  allowedSources: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>,
  profile: NotesRuntimeProfile
): NotesMappedClaim[] {
  ensureNoTimestampFields(value)
  if (totalOutputBytes(value) > profile.maxOutputTokens * MAX_OUTPUT_BYTES_PER_TOKEN) {
    fail('size-limit')
  }
  const claims = ensureArray(value, MAX_CLAIMS).map((claim) => {
    if (!isRecord(claim)) fail('invalid-model-output')
    ensureExactKeys(claim, [
      'text',
      'sourceIds',
      'modality',
      'topic',
      'salience',
      'exactReferences',
      'protectedSignals',
      'owner',
      'deadline'
    ])
    const sourceIds = parseSourceIds(claim.sourceIds)
    if (sourceIds.some((id) => !allowedSources.has(id))) fail('unknown-source-id')
    const modality = ensureString(claim.modality) as NotesModality
    if (!MODALITIES.has(modality)) fail('invalid-evidence')
    const salience = ensureString(claim.salience) as NotesSalience
    if (!SALIENCE.has(salience)) fail('invalid-evidence')
    const text = ensureString(claim.text)
    const declaredNames = parseExactReferences(
      claim.exactReferences,
      sourceIds,
      allowedSources
    ).filter((reference) => reference.kind === 'name')
    const detectedReferences = detectGroundedExactReferences(text, sourceIds, allowedSources)
    return {
      text,
      sourceIds,
      modality,
      topic: ensureNullableString(claim.topic),
      salience,
      exactReferences: mergeExactReferences([...declaredNames, ...detectedReferences]),
      protectedSignals: parseProtectedSignals(claim.protectedSignals),
      owner: parseOwner(claim.owner, sourceIds, allowedSources),
      deadline: parseDeadline(claim.deadline, sourceIds, allowedSources)
    }
  })
  return enrichProtectedClaims(claims, allowedSources)
}

export function validateReconciliation(
  value: unknown,
  evidence: readonly NotesEvidenceClaim[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>,
  profile: NotesRuntimeProfile
): NotesEvidenceGroup[] {
  ensureNoTimestampFields(value)
  if (totalOutputBytes(value) > profile.maxOutputTokens * MAX_OUTPUT_BYTES_PER_TOKEN) {
    fail('size-limit')
  }
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['groups'])
  const byId = new Map(evidence.map((claim) => [claim.id, claim]))
  const seen = new Set<NoteEvidenceId>()
  const groups = ensureArray(value.groups, MAX_GROUPS).map((group) => {
    if (!isRecord(group)) fail('invalid-model-output')
    ensureExactKeys(group, ['evidenceIds', 'primaryEvidenceId'])
    const evidenceIds = normalizeIds(
      ensureArray(group.evidenceIds).map((id) => ensureString(id) as NoteEvidenceId),
      'invalid-reconciliation'
    )
    if (evidenceIds.some((id) => !byId.has(id))) fail('unknown-evidence-id')
    if (evidenceIds.some((id) => seen.has(id))) fail('invalid-reconciliation')
    evidenceIds.forEach((id) => seen.add(id))
    const primaryEvidenceId = ensureString(group.primaryEvidenceId) as NoteEvidenceId
    if (!evidenceIds.includes(primaryEvidenceId)) fail('invalid-reconciliation')
    const modality = byId.get(evidenceIds[0])!.modality
    if (evidenceIds.some((id) => byId.get(id)!.modality !== modality)) {
      fail('invalid-reconciliation')
    }
    return {
      id: `group:${primaryEvidenceId}`,
      evidenceIds,
      primaryEvidenceId
    }
  })
  if (seen.size !== byId.size) fail('invalid-reconciliation')
  return groups.sort((left, right) => {
    const earliest = (group: NotesEvidenceGroup): number =>
      Math.min(
        ...group.evidenceIds.flatMap((id) =>
          byId.get(id)!.sourceIds.map((sourceId) => anchors.get(sourceId)!.startMs)
        )
      )
    return earliest(left) - earliest(right) || left.id.localeCompare(right.id)
  })
}

function validateEvidenceIds(
  value: unknown,
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>
): NoteEvidenceId[] {
  const ids = normalizeIds(
    ensureArray(value).map((id) => ensureString(id) as NoteEvidenceId),
    'missing-evidence'
  )
  if (ids.some((id) => !evidence.has(id))) fail('unknown-evidence-id')
  return ids
}

function parseRefBlock(
  value: unknown,
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>
): NotesEvidenceRefBlock {
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['text', 'evidenceIds'])
  return {
    text: ensureString(value.text),
    evidenceIds: validateEvidenceIds(value.evidenceIds, evidence)
  }
}

function hasEligibleMetadata(
  value: string,
  evidenceIds: readonly NoteEvidenceId[],
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  field: 'owner' | 'deadline'
): boolean {
  return evidenceIds.some((id) => evidence.get(id)![field]?.value === value)
}

function parseItem(
  value: unknown,
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  collection: 'item' | 'decision' | 'next-step'
): NotesReducedItem {
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['title', 'topic', 'owner', 'deadline', 'text', 'evidenceIds'])
  const item: NotesReducedItem = {
    title: ensureNullableString(value.title),
    topic: ensureNullableString(value.topic),
    owner: ensureNullableString(value.owner),
    deadline: ensureNullableString(value.deadline),
    text: ensureString(value.text),
    evidenceIds: validateEvidenceIds(value.evidenceIds, evidence)
  }
  if (
    item.owner !== null &&
    !hasEligibleMetadata(item.owner, item.evidenceIds, evidence, 'owner')
  ) {
    fail('unsupported-owner')
  }
  if (
    item.deadline !== null &&
    !hasEligibleMetadata(item.deadline, item.evidenceIds, evidence, 'deadline')
  ) {
    fail('unsupported-deadline')
  }
  if (
    collection === 'decision' &&
    !item.evidenceIds.some((id) => evidence.get(id)!.modality === 'decision-agreement')
  ) {
    fail('invalid-modality-promotion')
  }
  if (
    collection === 'next-step' &&
    !item.evidenceIds.some((id) => {
      const modality = evidence.get(id)!.modality
      return modality === 'explicit-request' || modality === 'commitment'
    })
  ) {
    fail('invalid-modality-promotion')
  }
  return item
}

function valuesForExactReferences(item: NotesEvidenceRefBlock | NotesReducedItem): string[] {
  if ('title' in item) {
    return [item.text, item.title ?? '', item.topic ?? '', item.owner ?? '', item.deadline ?? '']
  }
  return [item.text]
}

function sourceAnchorsForEvidence(
  evidenceIds: readonly NoteEvidenceId[],
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NotesTranscriptAnchor[] {
  const reached = new Map<NoteSourceId, NotesTranscriptAnchor>()
  for (const evidenceId of evidenceIds) {
    const claim = evidence.get(evidenceId)
    if (!claim) fail('unknown-evidence-id')
    for (const sourceId of claim.sourceIds) {
      const anchor = anchors.get(sourceId)
      if (!anchor) fail('unknown-source-id')
      reached.set(sourceId, anchor)
    }
  }
  return [...reached.values()]
}

function validateDisplayedExactLiterals(
  values: readonly string[],
  evidenceIds: readonly NoteEvidenceId[],
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): void {
  const sourceAnchors = sourceAnchorsForEvidence(evidenceIds, evidence, anchors)
  for (const { value } of values.flatMap(detectExactLiterals)) {
    if (!sourceAnchors.some((anchor) => literalInEvidence(value, anchor.text))) {
      fail('invalid-evidence')
    }
  }
}

function totalOutputBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + totalOutputBytes(item), 0)
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((total, item) => total + totalOutputBytes(item), 0)
  }
  return 0
}

export function validateReducerOutput(
  value: unknown,
  evidenceClaims: readonly NotesEvidenceClaim[],
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>,
  profile: NotesRuntimeProfile
): NotesReduceResult {
  ensureNoTimestampFields(value)
  if (totalOutputBytes(value) > profile.maxOutputTokens * MAX_OUTPUT_BYTES_PER_TOKEN) {
    fail('size-limit')
  }
  if (!isRecord(value)) fail('invalid-model-output')
  ensureExactKeys(value, ['overview', 'keyTakeaways', 'sections', 'decisions', 'nextSteps'])
  const evidence = new Map(evidenceClaims.map((claim) => [claim.id, claim]))
  const overview = value.overview === null ? null : parseRefBlock(value.overview, evidence)
  const keyTakeaways = ensureArray(value.keyTakeaways).map((item) =>
    parseItem(item, evidence, 'item')
  )
  const sections = ensureArray(value.sections, MAX_SECTIONS).map((section) => {
    if (!isRecord(section)) fail('invalid-model-output')
    ensureExactKeys(section, ['title', 'summary', 'keyPoints', 'supportingDetails'])
    const parsed = {
      title: ensureString(section.title),
      summary: section.summary === null ? null : parseRefBlock(section.summary, evidence),
      keyPoints: ensureArray(section.keyPoints).map((item) => parseItem(item, evidence, 'item')),
      supportingDetails: ensureArray(section.supportingDetails).map((item) =>
        parseItem(item, evidence, 'item')
      )
    }
    if (
      parsed.summary === null &&
      parsed.keyPoints.length === 0 &&
      parsed.supportingDetails.length === 0
    ) {
      fail('invalid-model-output')
    }
    return parsed
  })
  const result: NotesReduceResult = {
    overview,
    keyTakeaways,
    sections,
    decisions: ensureArray(value.decisions).map((item) => parseItem(item, evidence, 'decision')),
    nextSteps: ensureArray(value.nextSteps).map((item) => parseItem(item, evidence, 'next-step'))
  }
  const renderedBlocks: Array<NotesEvidenceRefBlock | NotesReducedItem> = [
    ...(result.overview === null ? [] : [result.overview]),
    ...result.keyTakeaways,
    ...result.sections.flatMap((section) => [
      ...(section.summary === null ? [] : [section.summary]),
      ...section.keyPoints,
      ...section.supportingDetails
    ]),
    ...result.decisions,
    ...result.nextSteps
  ]
  for (const block of renderedBlocks) {
    validateDisplayedExactLiterals(
      valuesForExactReferences(block),
      block.evidenceIds,
      evidence,
      anchors
    )
  }
  for (const section of result.sections) {
    const evidenceIds = [
      ...new Set([
        ...(section.summary?.evidenceIds ?? []),
        ...section.keyPoints.flatMap((item) => item.evidenceIds),
        ...section.supportingDetails.flatMap((item) => item.evidenceIds)
      ])
    ]
    validateDisplayedExactLiterals([section.title], evidenceIds, evidence, anchors)
  }
  for (const claim of evidenceClaims) {
    const citedBy = renderedBlocks.filter((block) => block.evidenceIds.includes(claim.id))
    if (
      (claim.protectedSignals.length > 0 || claim.exactReferences.length > 0) &&
      citedBy.length === 0
    ) {
      fail('missing-evidence')
    }
    if (
      citedBy.length > 0 &&
      claim.exactReferences.some(
        (reference) =>
          !citedBy.some((block) =>
            valuesForExactReferences(block).some((value) =>
              literalInEvidence(reference.value, value)
            )
          )
      )
    ) {
      fail('invalid-evidence')
    }
  }
  return result
}

export function resolveEvidenceSources(
  evidenceIds: readonly NoteEvidenceId[],
  evidence: ReadonlyMap<NoteEvidenceId, NotesEvidenceClaim>,
  anchors: ReadonlyMap<NoteSourceId, NotesTranscriptAnchor>
): NoteSourceRange[] {
  const ranges: NoteSourceRange[] = []
  for (const evidenceId of evidenceIds) {
    const claim = evidence.get(evidenceId)
    if (!claim) fail('unknown-evidence-id')
    for (const sourceId of claim.sourceIds) {
      const anchor = anchors.get(sourceId)
      if (!anchor) fail('unknown-source-id')
      ranges.push({ startMs: anchor.startMs, endMs: anchor.endMs })
    }
  }
  return normalizeNoteSources(ranges)
}
