import type { Segment, Transcript } from '../../shared/types'
import {
  actionSpeechActSupportsSummary,
  hasExplicitSingularFirstPersonCommitment
} from './notes-action-speech'
import { isPlausiblePersonOwner } from './notes-scan-markdown'
import { isWindowsTopicWriterEnabled } from './windows-notes-experiment'

const GENERIC_OWNER_LABEL =
  /^(?:i|me|myself|you|them|they|we|us|owner|speaker|someone|unknown|unassigned|tbd)$/iu

const OWNER_ASSIGNMENT_AFTER_NAME =
  /^\s*(?:will(?!\s+(?:not|never)\b)|must(?!\s+not\b)|needs?\s+to|is\s+going\s+to|is\s+gonna|owns?|is\s+responsible\s+for|agreed\s+to|committed\s+to|plans?\s+to)\b/iu

const OWNER_DIRECT_REQUEST_AFTER_NAME =
  /^\s*[,;:—-]?\s*(?:please\b|can\s+you\b|could\s+you\b|will\s+you\b)/iu

const OWNER_ASSIGNMENT_BEFORE_NAME =
  /\b(?:owner(?:\s+is)?|owned\s+by|assigned\s+to|responsible(?:\s+person)?(?:\s+is)?)[\s:,-]*$/iu

const REPORTED_SPEECH_CONTEXT =
  /\b(?:according\s+to|said|says|told|mentioned|wrote|asked|replied|promised)\b/iu

const NAMED_OWNER_CONTEXT_TOLERANCE_MS = 30_000

const COLLECTIVE_OWNER_TOKENS = new Set([
  'board',
  'company',
  'department',
  'design',
  'engineering',
  'finance',
  'group',
  'leadership',
  'legal',
  'management',
  'marketing',
  'operations',
  'ops',
  'product',
  'qa',
  'sales',
  'security',
  'support',
  'team',
  'vendor'
])

const ORGANIZATION_NAME_MARKERS = new Set([
  'app',
  'application',
  'bot',
  'company',
  'corp',
  'corporation',
  'department',
  'division',
  'group',
  'inc',
  'labs',
  'llc',
  'platform',
  'service',
  'services',
  'software',
  'studio',
  'system',
  'systems',
  'team',
  'technologies',
  'technology',
  'tool',
  'workspace'
])

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value)
}

function containsLiteral(text: string, literal: string): boolean {
  const normalizedText = text.toLowerCase()
  const normalizedLiteral = literal.toLowerCase()
  let start = normalizedText.indexOf(normalizedLiteral)

  while (start !== -1) {
    const end = start + normalizedLiteral.length
    const first = normalizedLiteral[0]
    const last = normalizedLiteral[normalizedLiteral.length - 1]
    const startsAtBoundary = !isWordCharacter(first) || !isWordCharacter(normalizedText[start - 1])
    const endsAtBoundary = !isWordCharacter(last) || !isWordCharacter(normalizedText[end])
    if (startsAtBoundary && endsAtBoundary) return true
    start = normalizedText.indexOf(normalizedLiteral, start + 1)
  }

  return false
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ownerHasOrganizationContext(
  owner: string,
  meetingId: string,
  transcriptRows: readonly Transcript[]
): boolean {
  const ownerTokens = owner.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (
    ownerTokens.some(
      (token) => COLLECTIVE_OWNER_TOKENS.has(token) || ORGANIZATION_NAME_MARKERS.has(token)
    )
  ) {
    return true
  }

  const literal = regexLiteral(owner)
  const beforeOwner = new RegExp(
    `\\b(?:in|inside|into|on|through|using|via|within)\\s+(?:the\\s+)?${literal}\\b`,
    'iu'
  )
  const afterOwner = new RegExp(
    `\\b${literal}\\s+(?:app|application|bot|company|department|division|group|integration|platform|service|software|system|team|tool|workspace)\\b`,
    'iu'
  )
  return transcriptRows.some(
    (row) =>
      row.meetingId === meetingId && (beforeOwner.test(row.text) || afterOwner.test(row.text))
  )
}

function ownerHasHumanContext(
  owner: string,
  meetingId: string,
  transcriptRows: readonly Transcript[],
  evidence: readonly Transcript[]
): boolean {
  const literal = regexLiteral(owner)
  const personInteraction = new RegExp(
    `\\b(?:ask|asked|call|called|contact|contacted|email|emailed|message|messaged|ping|pinged|remind|reminded|tell|told|thank|thanked)\\s+${literal}\\b`,
    'iu'
  )
  const speechAttribution = new RegExp(
    `\\b${literal}\\s+(?:asked|replied|said|says|told|wrote)\\b`,
    'iu'
  )
  const possessive = new RegExp(`\\b${literal}['’]s\\b`, 'iu')
  const directAddress = new RegExp(
    `(?:^|[.!?]\\s+)${literal}\\s*[,;:—-]\\s*(?:please\\b|can\\s+you\\b|could\\s+you\\b|will\\s+you\\b)`,
    'iu'
  )
  const evidenceStartMs = Math.min(...evidence.map((row) => row.startMs))
  const evidenceEndMs = Math.max(...evidence.map((row) => row.endMs))
  return transcriptRows.some(
    (row) =>
      row.meetingId === meetingId &&
      Number.isFinite(row.startMs) &&
      Number.isFinite(row.endMs) &&
      row.endMs >= evidenceStartMs - NAMED_OWNER_CONTEXT_TOLERANCE_MS &&
      row.startMs <= evidenceEndMs + NAMED_OWNER_CONTEXT_TOLERANCE_MS &&
      (row.speaker.trim().toLocaleLowerCase() === owner.trim().toLocaleLowerCase() ||
        personInteraction.test(row.text) ||
        speechAttribution.test(row.text) ||
        possessive.test(row.text) ||
        directAddress.test(row.text))
  )
}

function namedOwnerHasPersonContext(
  owner: string,
  evidence: readonly Transcript[],
  transcriptRows: readonly Transcript[],
  meetingId: string
): boolean {
  if (ownerHasOrganizationContext(owner, meetingId, transcriptRows)) return false

  const ownerTokenCount = owner.trim().split(/\s+/u).length
  if (ownerTokenCount > 1) return true
  if (
    evidence.some((row) => {
      const ownerStart = row.text.toLocaleLowerCase().indexOf(owner.toLocaleLowerCase())
      return (
        ownerStart >= 0 &&
        OWNER_DIRECT_REQUEST_AFTER_NAME.test(row.text.slice(ownerStart + owner.length))
      )
    })
  ) {
    return true
  }
  return ownerHasHumanContext(owner, meetingId, transcriptRows, evidence)
}

function citedTranscriptRows(
  segment: Segment,
  transcriptRows: readonly Transcript[]
): readonly Transcript[] {
  if (
    !Number.isFinite(segment.sourceStartMs) ||
    !Number.isFinite(segment.sourceEndMs) ||
    segment.sourceStartMs > segment.sourceEndMs
  ) {
    return []
  }

  return transcriptRows.filter(
    (row) =>
      row.meetingId === segment.meetingId &&
      Number.isFinite(row.startMs) &&
      Number.isFinite(row.endMs) &&
      row.startMs <= segment.sourceEndMs &&
      row.endMs >= segment.sourceStartMs
  )
}

function explicitNamedOwner(assignee: string | null): string | null {
  const candidate = assignee?.trim() ?? ''
  const validationCase = candidate
    .toLocaleLowerCase()
    .replace(/(^|[\s'’-])\p{L}/gu, (match) => match.toLocaleUpperCase())
  if (
    !candidate ||
    GENERIC_OWNER_LABEL.test(candidate) ||
    (!isPlausiblePersonOwner(candidate) && !isPlausiblePersonOwner(validationCase))
  ) {
    return null
  }
  return candidate
}

function hasNamedAssignment(rowText: string, owner: string): boolean {
  const lowerText = rowText.toLowerCase()
  const lowerOwner = owner.toLowerCase()
  let start = lowerText.indexOf(lowerOwner)

  while (start !== -1) {
    const end = start + lowerOwner.length
    const before = rowText.slice(Math.max(0, start - 48), start)
    const beforeClause = before.split(/[.!?]/u).at(-1) ?? before
    const after = rowText.slice(end, end + 64)
    const firstClauseAfterOwner = after.split(/[.!?;,]/u, 1)[0] ?? after
    const negated = /\b(?:not|never)\b/iu.test(firstClauseAfterOwner)
    if (
      !negated &&
      !REPORTED_SPEECH_CONTEXT.test(beforeClause) &&
      (OWNER_ASSIGNMENT_AFTER_NAME.test(after) ||
        OWNER_DIRECT_REQUEST_AFTER_NAME.test(after) ||
        OWNER_ASSIGNMENT_BEFORE_NAME.test(before))
    ) {
      return true
    }
    start = lowerText.indexOf(lowerOwner, start + 1)
  }

  return false
}

/**
 * Resolves only owner identities supported by the writer segment's cited transcript range.
 * This is deliberately deterministic and conservative: it performs no diarization or model call.
 */
export function resolveSpeakerAwareOwner(
  segment: Segment,
  transcriptRows: readonly Transcript[],
  localOwnerLabel?: string | null
): string | null {
  const evidence = citedTranscriptRows(segment, transcriptRows)
  if (evidence.length === 0) return null

  const namedInSentence = isWindowsTopicWriterEnabled()
    ? segment.content.match(/^(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?)\s+(?:will|must|needs?\s+to)\b/u)?.[1]
    : undefined
  const namedOwner = explicitNamedOwner(segment.assignee ?? namedInSentence ?? null)
  if (
    namedOwner &&
    namedOwnerHasPersonContext(namedOwner, evidence, transcriptRows, segment.meetingId) &&
    evidence.some(
      (row) =>
        containsLiteral(row.text, namedOwner) &&
        hasNamedAssignment(row.text, namedOwner) &&
        actionSpeechActSupportsSummary(row.text, `${segment.title} ${segment.content}`, namedOwner)
    )
  ) {
    return namedOwner
  }

  const confirmedLocalOwner = localOwnerLabel?.trim() ?? ''
  if (!confirmedLocalOwner) return null

  const hasLocalCommitment = evidence.some(
    (row) =>
      row.speaker.trim().toLowerCase() === 'me' &&
      hasExplicitSingularFirstPersonCommitment(row.text) &&
      actionSpeechActSupportsSummary(row.text, `${segment.title} ${segment.content}`)
  )
  return hasLocalCommitment ? confirmedLocalOwner : null
}
