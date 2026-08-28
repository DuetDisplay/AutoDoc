import { createHash } from 'crypto'
import type { MeetingSegments, Segment, Transcript } from '../../shared/types'
import { noteTextLooksCoherent } from './notes-coherence'

export interface ExplicitTranscriptDecisionRecoveryResult {
  segments: MeetingSegments
  recoveredDecisionCount: number
  promotedDecisionCount: number
  dedupedRecoveredDecisionCount: number
}

interface DecisionCandidate {
  meetingId: string
  title: string
  content: string
  sourceStartMs: number
  sourceEndMs: number
  objectTokens: ReadonlySet<string>
}

const DIRECT_DECISION =
  /\b(?:(?:we|i|the\s+team)\s+(?:have\s+)?)(?:decided|agreed|approved|chose|selected|settled)\s+(?:to|on|that\s+)?(?<body>[^;!?]+)/iu
const FINAL_DECISION = /\b(?:the|our)\s+(?:final\s+)?decision\s+is\s+(?:to\s+)?(?<body>[^;!?]+)/iu
const PLAN_DECISION =
  /\b(?:the|our)\s+(?:final\s+)?(?:plan|approach)\s+is\s+(?:to\s+)?(?<body>[^;!?]+)/iu
const DIRECTIVE_DECISION = /\blet['’]s\s+(?<body>[^;!?]+)/iu
const DIRECTION_DECISION =
  /\bwe(?:['’]re|\s+are)\s+(?<body>(?:going\s+with|defaulting\s+to|holding\s+off(?:\s+on)?|waiting\s+until|sticking\s+with|switching\s+to)[^;!?]+)/iu

const PROPOSAL =
  /\b(?:should\s+we|why\s+don['’]t\s+we|how\s+about\s+we|what\s+if\s+we|i\s+(?:propose|recommend)\s+(?:that\s+)?we|i\s+think\s+we\s+should)\s+(?<body>[^;!?]+)/iu
const ACCEPTANCE =
  /^\s*(?:yeah|yes|yep|okay|ok|agreed|sounds\s+good|that\s+works|let['’]s\s+do\s+it|do\s+that)(?:[,.!]|\s|$)/iu
const HESITANT_ACCEPTANCE = /\b(?:maybe|might|not\s+sure|possibly|perhaps|i\s+guess)\b/iu

const DECISIVE_ACTION =
  /^(?:not\s+)?(?:adopt|approve|cancel|choose|default|delay|drop|hold\s+off|keep|launch|make|move|pause|postpone|proceed|release|remove|replace|roll\s*out|ship|start|stop|switch|use|wait)\b/iu
const TENTATIVE_BODY =
  /^(?:maybe|might|possibly|perhaps|probably|consider|considering|think\s+about)\b/iu
const UNCERTAIN_CONTEXT =
  /\b(?:apparently|assuming|can['’]t\s+remember|depending|guess|if|might|maybe|not\s+sure|possibly|perhaps|probably|seems?|thought|unless)\b/iu
const ANAPHORIC_DECISION_BODY =
  /^(?:about\s+)?(?:it|that|this|those|these|with\s+(?:you|him|her|them|the\s+reasoning|your\s+reasoning))\b/iu
const ALTERNATIVE_QUESTION = /\bor\b/iu
const VAGUE_PROPOSAL_OBJECT = new Set([
  'anything',
  'bit',
  'little',
  'more',
  'something',
  'stuff',
  'thing',
  'things'
])
const CLAUSE_SPLIT = /(?<=[.!?;])\s+|\s+[—–]\s+/u

const TOKEN_STOP = new Set([
  'about',
  'adopt',
  'agree',
  'agreed',
  'approve',
  'approved',
  'are',
  'cancel',
  'choose',
  'chose',
  'decide',
  'decided',
  'default',
  'delay',
  'drop',
  'going',
  'hold',
  'keep',
  'launch',
  'make',
  'move',
  'not',
  'off',
  'pause',
  'plan',
  'postpone',
  'proceed',
  'release',
  'remove',
  'replace',
  'roll',
  'selected',
  'settled',
  'ship',
  'should',
  'start',
  'sticking',
  'stop',
  'switch',
  'team',
  'that',
  'the',
  'this',
  'until',
  'use',
  'wait',
  'we',
  'will',
  'with'
])

function normalizeToken(token: string): string {
  let normalized = token.toLocaleLowerCase()
  if (normalized.endsWith('ing') && normalized.length > 6) normalized = normalized.slice(0, -3)
  else if (normalized.endsWith('ed') && normalized.length > 5) normalized = normalized.slice(0, -2)
  else if (normalized.endsWith('s') && normalized.length > 5) normalized = normalized.slice(0, -1)
  return normalized
}

function objectTokens(text: string): Set<string> {
  return new Set(
    (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]{2,}/gu) ?? [])
      .map(normalizeToken)
      .filter((token) => token.length >= 3 && !TOKEN_STOP.has(token))
  )
}

function acceptedProposalHasConcreteObject(body: string): boolean {
  const words = body.replace(/^(?:just|now|then)\s+/iu, '').match(/[\p{L}\p{N}'’.-]+/gu) ?? []
  return words
    .slice(1)
    .map(normalizeToken)
    .some(
      (token) => token.length >= 3 && !TOKEN_STOP.has(token) && !VAGUE_PROPOSAL_OBJECT.has(token)
    )
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const denominator = Math.min(left.size, right.size)
  if (denominator === 0) return 0
  return [...left].filter((token) => right.has(token)).length / denominator
}

function cleanBody(raw: string): string {
  return raw
    .replace(/\s+/gu, ' ')
    .replace(/^(?:to|on|that)\s+/iu, '')
    .replace(/[,.:—-]+\s*$/u, '')
    .trim()
}

function sentence(text: string): string {
  const compact = text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[,;:—-]+$/u, '')
  if (!compact) return ''
  const capitalized = `${compact[0]!.toLocaleUpperCase()}${compact.slice(1)}`
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`
}

function titleForBody(body: string): string {
  const clean = sentence(body).replace(/[.!?]+$/u, '')
  if (clean.length <= 96) return clean
  return clean.slice(0, 96).replace(/\s+\S*$/u, '')
}

function concreteBody(body: string, requireDecisiveAction: boolean): boolean {
  const clean = cleanBody(body)
  if (!clean || TENTATIVE_BODY.test(clean) || ANAPHORIC_DECISION_BODY.test(clean)) return false
  if (requireDecisiveAction && !DECISIVE_ACTION.test(clean)) return false
  return objectTokens(clean).size > 0 && noteTextLooksCoherent(sentence(clean))
}

function directCandidate(row: Transcript, clause: string): DecisionCandidate | null {
  const patterns: ReadonlyArray<{ pattern: RegExp; requireDecisiveAction: boolean }> = [
    { pattern: DIRECT_DECISION, requireDecisiveAction: false },
    { pattern: FINAL_DECISION, requireDecisiveAction: false },
    { pattern: PLAN_DECISION, requireDecisiveAction: true },
    { pattern: DIRECTION_DECISION, requireDecisiveAction: false },
    { pattern: DIRECTIVE_DECISION, requireDecisiveAction: true }
  ]
  for (const { pattern, requireDecisiveAction } of patterns) {
    const match = pattern.exec(clause)
    const rawBody = match?.groups?.body?.trim() ?? ''
    const body = cleanBody(rawBody)
    if (
      !match ||
      UNCERTAIN_CONTEXT.test(clause) ||
      ANAPHORIC_DECISION_BODY.test(rawBody) ||
      !concreteBody(body, requireDecisiveAction)
    ) {
      continue
    }
    const content = sentence(clause.slice(match.index))
    if (!noteTextLooksCoherent(content)) continue
    return {
      meetingId: row.meetingId,
      title: titleForBody(body),
      content,
      sourceStartMs: row.startMs,
      sourceEndMs: row.endMs,
      objectTokens: objectTokens(body)
    }
  }
  return null
}

function acceptedProposalCandidate(
  proposalRow: Transcript,
  acceptanceRow: Transcript
): DecisionCandidate | null {
  if (
    proposalRow.meetingId !== acceptanceRow.meetingId ||
    acceptanceRow.startMs - proposalRow.endMs > 15_000 ||
    !ACCEPTANCE.test(acceptanceRow.text) ||
    HESITANT_ACCEPTANCE.test(acceptanceRow.text)
  ) {
    return null
  }

  for (const clause of proposalRow.text.split(CLAUSE_SPLIT)) {
    const proposal = PROPOSAL.exec(clause)
    const body = cleanBody(proposal?.groups?.body ?? '')
    if (
      !proposal ||
      ALTERNATIVE_QUESTION.test(body) ||
      !concreteBody(body, false) ||
      !acceptedProposalHasConcreteObject(body)
    ) {
      continue
    }
    const content = sentence(body)
    return {
      meetingId: proposalRow.meetingId,
      title: titleForBody(body),
      content,
      sourceStartMs: proposalRow.startMs,
      sourceEndMs: acceptanceRow.endMs,
      objectTokens: objectTokens(body)
    }
  }
  return null
}

function segmentTokens(segment: Segment): Set<string> {
  return objectTokens(`${segment.title} ${segment.content}`)
}

function sourceOverlaps(candidate: DecisionCandidate, segment: Segment): boolean {
  return (
    candidate.meetingId === segment.meetingId &&
    candidate.sourceStartMs <= segment.sourceEndMs &&
    candidate.sourceEndMs >= segment.sourceStartMs
  )
}

function duplicate(candidate: DecisionCandidate, segment: Segment): boolean {
  return overlap(candidate.objectTokens, segmentTokens(segment)) >= 0.65
}

function candidateSegment(candidate: DecisionCandidate): Segment {
  const id = createHash('sha256')
    .update(
      [
        candidate.meetingId,
        candidate.sourceStartMs,
        candidate.sourceEndMs,
        candidate.content.toLocaleLowerCase()
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 16)
  return {
    id: `recovered-decision:${id}`,
    meetingId: candidate.meetingId,
    category: 'decision',
    topic: null,
    title: candidate.title,
    content: candidate.content,
    assignee: null,
    deadline: null,
    sourceStartMs: candidate.sourceStartMs,
    sourceEndMs: candidate.sourceEndMs
  }
}

function candidateKey(candidate: DecisionCandidate): string {
  return [...candidate.objectTokens].sort().join('|')
}

/**
 * Recovers only explicit choices and accepted concrete proposals. Suggestions,
 * open questions, and tentative language remain discussion rather than being
 * promoted into decisions.
 */
export function recoverExplicitTranscriptDecisions(
  segments: MeetingSegments,
  transcriptRows: readonly Transcript[]
): ExplicitTranscriptDecisionRecoveryResult {
  const augmented: MeetingSegments = {
    decisions: [...segments.decisions],
    actionItems: [...segments.actionItems],
    information: [...segments.information],
    discussion: [...segments.discussion],
    statusUpdates: [...segments.statusUpdates]
  }
  const rows = transcriptRows
    .filter(
      (row) =>
        Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs <= row.endMs
    )
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)

  const rawCandidates: DecisionCandidate[] = []
  for (const [index, row] of rows.entries()) {
    for (const clause of row.text.split(CLAUSE_SPLIT)) {
      const direct = directCandidate(row, clause)
      if (direct) rawCandidates.push(direct)
    }
    for (let offset = 1; offset <= 2 && index + offset < rows.length; offset += 1) {
      const accepted = acceptedProposalCandidate(row, rows[index + offset]!)
      if (accepted) {
        rawCandidates.push(accepted)
        break
      }
    }
  }

  const candidates: DecisionCandidate[] = []
  let dedupedRecoveredDecisionCount = 0
  const candidateKeys = new Set<string>()
  for (const candidate of rawCandidates) {
    const key = candidateKey(candidate)
    if (candidateKeys.has(key)) {
      dedupedRecoveredDecisionCount += 1
      continue
    }
    candidateKeys.add(key)
    candidates.push(candidate)
  }

  let recoveredDecisionCount = 0
  let promotedDecisionCount = 0
  const promotableBuckets = ['information', 'discussion', 'statusUpdates'] as const

  for (const candidate of candidates) {
    if (augmented.decisions.some((segment) => duplicate(candidate, segment))) {
      dedupedRecoveredDecisionCount += 1
      continue
    }

    let promoted = false
    for (const bucket of promotableBuckets) {
      const index = augmented[bucket].findIndex(
        (segment) => sourceOverlaps(candidate, segment) && duplicate(candidate, segment)
      )
      if (index < 0) continue
      const [source] = augmented[bucket].splice(index, 1)
      augmented.decisions.push({ ...source!, category: 'decision' })
      promotedDecisionCount += 1
      promoted = true
      break
    }
    if (promoted) continue

    augmented.decisions.push(candidateSegment(candidate))
    recoveredDecisionCount += 1
  }

  augmented.decisions.sort(
    (left, right) =>
      left.sourceStartMs - right.sourceStartMs ||
      left.sourceEndMs - right.sourceEndMs ||
      left.id.localeCompare(right.id)
  )

  return {
    segments: augmented,
    recoveredDecisionCount,
    promotedDecisionCount,
    dedupedRecoveredDecisionCount
  }
}
