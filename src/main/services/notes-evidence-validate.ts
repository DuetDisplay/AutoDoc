import { createHash } from 'crypto'
import type { MeetingNotesContent, NoteItem, NoteSection } from '../../shared/types'
import { isPlausiblePersonOwner } from './notes-scan-markdown'

export const LEDGER_CHUNK_CHAR_LIMIT = 6000
export const EVIDENCE_WINDOW_ROWS = 8
export const EVIDENCE_WINDOW_STRIDE = 4
export const EVIDENCE_WINDOW_EXTEND_ROWS = 10
export const EVIDENCE_WINDOWS_PER_CLAIM = 2
export const CLAIM_BATCH_SIZE = 8
export const LEDGER_DEDUPE_RATIO = 0.6
export const COVERAGE_APPEND_CAP = 8
export const COVERAGE_SHARED_TOKEN_MIN = 3
export const COVERAGE_SHARED_RATIO = 0.6
export const TICKET_LEDGER_RE = /\bDD[- ]?\d{3,5}\b/gi
const TICKET_LEDGER_TEXT_MAX = 200

export interface TranscriptRow {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export type LedgerKind = 'decision' | 'commitment' | 'quantity'

export interface LedgerEntry {
  kind: LedgerKind
  text: string
  owner: string | null
  quote: string
  startMs: number
  endMs: number
}

export interface TranscriptChunk {
  rows: TranscriptRow[]
  text: string
  startMs: number
  endMs: number
}

export type ClaimKind = 'takeaway' | 'nextStep' | 'sectionClaim'
export type ClaimVerdict = 'supported' | 'proposed' | 'unsupported'

export interface EvidenceClaim {
  id: string
  kind: ClaimKind
  text: string
  owner: string | null
}

export interface ClaimVerdictRecord {
  id: string
  verdict: ClaimVerdict
  owner: string | null
}

export interface EvidenceWindow {
  rows: TranscriptRow[]
  score: number
  startMs: number
  endMs: number
}

export interface NotesValidationStats {
  ran: boolean
  error: string | null
  ledgerChunksFailed: number
  claimsChecked: number
  claimsDropped: number
  ownersStripped: number
  ledgerAppends: number
  unvalidatedClaims: number
}

export interface EvidenceGenerateRequest {
  prompt: string
  num_ctx: number
  num_predict: number
  temperature: number
  seed: number
  stop: readonly string[]
}

export type EvidenceGenerateFn = (request: EvidenceGenerateRequest) => Promise<string>

const AGREEMENT_ASSERTION = /\b(agreed|decided|decision|finalized|approved|selected|chosen|confirmed)\b/i

export const LEDGER_PROMPT_PREFIX = `Extract critical outcomes from the transcript chunk.
Return ONLY a JSON array. No markdown. No extra text.
Schema: [{"kind":"decision"|"commitment"|"quantity","text":"...","owner":"Name or null","quote":"verbatim words from the transcript"}]
Rules:
- decision: agreed or decided outcome
- commitment: promised action or next step
- quantity: a count, metric, version, or ticket id
- quote must be copied verbatim from the chunk
- owner is the assigned person, or null
- omit items with no supporting quote
- use [] if none

CHUNK:
`

export const VERIFICATION_PROMPT_PREFIX = `Judge each claim against its transcript evidence.
Return ONLY a JSON array. No markdown. No extra text.
Schema: [{"id":"...","verdict":"supported"|"proposed"|"unsupported","owner":"Name or null"}]
Verdicts:
- supported: the evidence shows an explicit final agreement, completed fact, or unambiguous decision
- proposed: suggested, favored, or discussed, or the decision was deferred for later feedback or discussion
- unsupported: missing from the evidence or contradicted
owner: person the evidence explicitly assigns, else null

`

export function emptyValidationStats(ran = false): NotesValidationStats {
  return {
    ran,
    error: null,
    ledgerChunksFailed: 0,
    claimsChecked: 0,
    claimsDropped: 0,
    ownersStripped: 0,
    ledgerAppends: 0,
    unvalidatedClaims: 0
  }
}

export function formatTranscriptTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatTranscriptRow(row: TranscriptRow): string {
  return `[${formatTranscriptTimestamp(row.startMs)}] ${row.speaker}: ${row.text}`
}

export function formatTranscriptRows(rows: readonly TranscriptRow[]): string {
  return rows.map((row) => formatTranscriptRow(row)).join('\n')
}

export function contentTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
}

export function uniqueContentTokens(text: string): Set<string> {
  return new Set(contentTokens(text))
}

export function sharedContentTokens(left: string, right: string): string[] {
  const rightSet = uniqueContentTokens(right)
  const seen = new Set<string>()
  const shared: string[] = []
  for (const token of uniqueContentTokens(left)) {
    if (!rightSet.has(token) || seen.has(token)) continue
    seen.add(token)
    shared.push(token)
  }
  return shared
}

export function normalizeQuoteHaystack(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function quoteIsInChunk(quote: string, chunkText: string): boolean {
  const needle = normalizeQuoteHaystack(quote)
  if (!needle) return false
  return normalizeQuoteHaystack(chunkText).includes(needle)
}

export function isPlausiblePersonName(value: string | null | undefined): value is string {
  return typeof value === 'string' && isPlausiblePersonOwner(value)
}

export function chunkTranscript(
  rows: readonly TranscriptRow[],
  maxChars = LEDGER_CHUNK_CHAR_LIMIT
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let current: TranscriptRow[] = []
  let currentChars = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(toTranscriptChunk(current))
    current = []
    currentChars = 0
  }

  for (const row of rows) {
    const formatted = formatTranscriptRow(row)
    const nextChars = currentChars === 0 ? formatted.length : currentChars + 1 + formatted.length
    if (current.length > 0 && nextChars > maxChars) {
      flush()
    }
    current.push({ ...row })
    currentChars = currentChars === 0 ? formatted.length : currentChars + 1 + formatted.length
  }
  flush()
  return chunks
}

function toTranscriptChunk(rows: readonly TranscriptRow[]): TranscriptChunk {
  return {
    rows: rows.map((row) => ({ ...row })),
    text: formatTranscriptRows(rows),
    startMs: rows[0]?.startMs ?? 0,
    endMs: rows[rows.length - 1]?.endMs ?? rows[0]?.endMs ?? 0
  }
}

export function buildLedgerPrompt(chunkText: string): string {
  return `${LEDGER_PROMPT_PREFIX}${chunkText}`
}

export function buildVerificationPrompt(
  batch: readonly { claim: EvidenceClaim; windows: readonly EvidenceWindow[] }[]
): string {
  const blocks = batch.map(({ claim, windows }) => {
    const evidence =
      windows.length === 0
        ? '(no matching transcript windows)'
        : windows
            .map((window) => formatTranscriptRows(window.rows))
            .join('\n---\n')
    return `CLAIM ${claim.id}
text: ${claim.text}
evidence:
${evidence}`
  })
  return `${VERIFICATION_PROMPT_PREFIX}${blocks.join('\n\n')}`
}

export function extractJsonArray(raw: string): unknown[] | null {
  const stripped = raw.trim()
  const start = stripped.indexOf('[')
  const end = stripped.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asLedgerKind(value: unknown): LedgerKind | null {
  return value === 'decision' || value === 'commitment' || value === 'quantity' ? value : null
}

function asVerdict(value: unknown): ClaimVerdict | null {
  return value === 'supported' || value === 'proposed' || value === 'unsupported' ? value : null
}

function asOwner(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /^null$/i.test(trimmed) || /^name or null$/i.test(trimmed)) return null
  return trimmed
}

export function filterLedgerEntries(
  parsed: readonly unknown[],
  chunkText: string,
  span: { startMs: number; endMs: number }
): LedgerEntry[] {
  const entries: LedgerEntry[] = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue
    const record = row as { kind?: unknown; text?: unknown; owner?: unknown; quote?: unknown }
    const kind = asLedgerKind(record.kind)
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const quote = typeof record.quote === 'string' ? record.quote : ''
    if (!kind || !text || !quoteIsInChunk(quote, chunkText)) continue
    entries.push({
      kind,
      text,
      owner: asOwner(record.owner),
      quote,
      startMs: span.startMs,
      endMs: span.endMs
    })
  }
  return entries
}

export function entriesAreNearDuplicate(left: LedgerEntry, right: LedgerEntry): boolean {
  const leftText = `${left.text} ${left.quote}`
  const rightText = `${right.text} ${right.quote}`
  const leftTokens = uniqueContentTokens(leftText)
  const rightTokens = uniqueContentTokens(rightText)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizeQuoteHaystack(leftText) === normalizeQuoteHaystack(rightText)
  }
  const shared = sharedContentTokens(leftText, rightText).length
  const baseline = Math.min(leftTokens.size, rightTokens.size)
  return baseline > 0 && shared / baseline >= LEDGER_DEDUPE_RATIO
}

export function normalizeTicketId(ticket: string): string {
  return ticket.replace(/[- ]/g, '').toUpperCase()
}

export function ticketIdsInText(text: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(new RegExp(TICKET_LEDGER_RE.source, TICKET_LEDGER_RE.flags))) {
    const normalized = normalizeTicketId(match[0])
    if (seen.has(normalized)) continue
    seen.add(normalized)
    ids.push(normalized)
  }
  return ids
}

export function supplementLedgerTickets(
  ledger: readonly LedgerEntry[],
  rows: readonly TranscriptRow[]
): LedgerEntry[] {
  const seen = new Set<string>()
  for (const entry of ledger) {
    for (const id of ticketIdsInText(`${entry.text} ${entry.quote}`)) {
      seen.add(id)
    }
  }
  const extra: LedgerEntry[] = []
  for (const row of rows) {
    for (const id of ticketIdsInText(row.text)) {
      if (seen.has(id)) continue
      seen.add(id)
      extra.push({
        kind: 'quantity',
        text: row.text.trim().slice(0, TICKET_LEDGER_TEXT_MAX),
        owner: null,
        quote: row.text,
        startMs: row.startMs,
        endMs: row.endMs
      })
    }
  }
  return extra.length === 0 ? [...ledger] : [...ledger, ...extra]
}

export function dedupeLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const kept: LedgerEntry[] = []
  for (const entry of entries) {
    if (kept.some((existing) => entriesAreNearDuplicate(existing, entry))) continue
    kept.push(entry)
  }
  return kept
}

function claimText(item: NoteItem): string {
  return [item.title, item.text].filter((part) => part && part.trim()).join(' ')
}

export function assertsAgreement(text: string): boolean {
  return AGREEMENT_ASSERTION.test(text)
}

export function sectionClaimId(sectionId: string, itemId: string): string {
  return `${sectionId}:${itemId}`
}

export function collectEvidenceClaims(content: MeetingNotesContent): EvidenceClaim[] {
  const claims: EvidenceClaim[] = []
  for (const item of content.keyTakeaways) {
    claims.push({
      id: item.id,
      kind: 'takeaway',
      text: claimText(item),
      owner: item.owner
    })
  }
  for (const item of content.nextSteps) {
    claims.push({
      id: item.id,
      kind: 'nextStep',
      text: claimText(item),
      owner: item.owner
    })
  }
  for (const section of content.sections) {
    for (const item of [...section.keyPoints, ...section.supportingDetails]) {
      const text = claimText(item)
      if (!assertsAgreement(text)) continue
      claims.push({
        id: sectionClaimId(section.id, item.id),
        kind: 'sectionClaim',
        text,
        owner: item.owner
      })
    }
  }
  return claims
}

function extendSelectedWindows(
  selected: readonly { start: number; length: number; score: number }[],
  rows: readonly TranscriptRow[],
  extendBy: number
): EvidenceWindow[] {
  const ranges = selected
    .map((window) => {
      const end = Math.min(rows.length, window.start + window.length + extendBy)
      return { start: window.start, end, score: window.score }
    })
    .sort((left, right) => left.start - right.start)

  const merged: { start: number; end: number; score: number }[] = []
  for (const range of ranges) {
    const prev = merged[merged.length - 1]
    if (prev && range.start <= prev.end) {
      prev.end = Math.max(prev.end, range.end)
      prev.score = Math.max(prev.score, range.score)
      continue
    }
    merged.push({ ...range })
  }

  return merged.map((range) => {
    const slice = rows.slice(range.start, range.end)
    return {
      rows: slice.map((row) => ({ ...row })),
      score: range.score,
      startMs: slice[0]?.startMs ?? 0,
      endMs: slice[slice.length - 1]?.endMs ?? 0
    }
  })
}

export function retrieveEvidenceWindows(
  claimText: string,
  rows: readonly TranscriptRow[],
  options?: { windowRows?: number; stride?: number; top?: number }
): EvidenceWindow[] {
  const windowRows = options?.windowRows ?? EVIDENCE_WINDOW_ROWS
  const stride = options?.stride ?? EVIDENCE_WINDOW_STRIDE
  const top = options?.top ?? EVIDENCE_WINDOWS_PER_CLAIM
  if (rows.length === 0) return []

  const claimTokens = uniqueContentTokens(claimText)
  const candidates: { start: number; length: number; score: number; startMs: number }[] = []
  const step = Math.max(1, stride)
  for (let start = 0; start < rows.length; start += step) {
    const slice = rows.slice(start, start + windowRows)
    if (slice.length === 0) break
    const windowText = slice.map((row) => row.text).join(' ')
    const score = claimTokens.size === 0 ? 0 : sharedContentTokens(claimText, windowText).length
    candidates.push({
      start,
      length: slice.length,
      score,
      startMs: slice[0]?.startMs ?? 0
    })
    if (start + windowRows >= rows.length) break
  }

  const selected = candidates
    .sort((left, right) => right.score - left.score || left.startMs - right.startMs)
    .slice(0, top)

  return extendSelectedWindows(selected, rows, EVIDENCE_WINDOW_EXTEND_ROWS)
}

export function documentCoversLedgerEntry(entry: LedgerEntry, documentText: string): boolean {
  const entryText = `${entry.text} ${entry.quote}`
  // Ticket IDs are the payload of their entries: generic token overlap does not
  // count as coverage unless the IDs themselves survived into the document.
  const tickets = ticketIdsInText(entryText)
  if (tickets.length > 0) {
    const documentTickets = new Set(ticketIdsInText(documentText))
    return tickets.every((ticket) => documentTickets.has(ticket))
  }
  const entryTokenCount = uniqueContentTokens(entryText).size
  const shared = sharedContentTokens(entryText, documentText).length
  if (shared >= COVERAGE_SHARED_TOKEN_MIN) return true
  return entryTokenCount > 0 && shared / entryTokenCount >= COVERAGE_SHARED_RATIO
}

export function flattenNotesText(content: MeetingNotesContent): string {
  const parts: string[] = []
  if (content.overview?.text) parts.push(content.overview.text)
  for (const item of content.keyTakeaways) {
    parts.push(`${item.title ?? ''} ${item.text}`)
  }
  for (const section of content.sections) {
    parts.push(section.title)
    if (section.summary?.text) parts.push(section.summary.text)
    for (const item of [...section.keyPoints, ...section.supportingDetails]) {
      parts.push(`${item.title ?? ''} ${item.text} ${item.owner ?? ''}`)
    }
  }
  for (const item of [...content.decisions, ...content.nextSteps]) {
    parts.push(`${item.title ?? ''} ${item.text} ${item.owner ?? ''}`)
  }
  return parts.join('\n')
}

function scanItemId(prefix: string, text: string): string {
  return `${prefix}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

function coverageItemText(entry: LedgerEntry): string {
  const owner =
    entry.owner && isPlausiblePersonName(entry.owner) ? ` — ${entry.owner.trim()}` : ''
  return `${entry.text}${owner}`
}

function bestSectionIndex(sections: readonly NoteSection[], entryText: string): number {
  let best = -1
  let bestScore = 0
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (!section) continue
    const haystack = [
      section.title,
      section.summary?.text ?? '',
      ...section.keyPoints.map((item) => `${item.title ?? ''} ${item.text}`),
      ...section.supportingDetails.map((item) => `${item.title ?? ''} ${item.text}`)
    ].join(' ')
    const score = sharedContentTokens(entryText, haystack).length
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  if (best < 0 || bestScore === 0) return sections.length - 1
  return best
}

function ledgerPriority(kind: LedgerKind): number {
  if (kind === 'decision') return 0
  if (kind === 'commitment') return 1
  return 2
}

export function applyClaimVerdicts(
  content: MeetingNotesContent,
  verdicts: ReadonlyMap<string, ClaimVerdictRecord>
): { content: MeetingNotesContent; dropped: number; ownersStripped: number } {
  let dropped = 0
  let ownersStripped = 0

  const keyTakeaways = content.keyTakeaways.filter((item) => {
    const verdict = verdicts.get(item.id)
    if (!verdict) return true
    if (verdict.verdict === 'unsupported') {
      dropped += 1
      return false
    }
    if (verdict.verdict === 'proposed' && assertsAgreement(`${item.title ?? ''} ${item.text}`)) {
      dropped += 1
      return false
    }
    return true
  })

  const nextSteps = content.nextSteps.flatMap((item) => {
    const verdict = verdicts.get(item.id)
    if (!verdict) return [item]
    if (verdict.verdict === 'unsupported') {
      dropped += 1
      return []
    }
    const confirmed = isPlausiblePersonName(verdict.owner) ? verdict.owner.trim() : null
    const original = item.owner?.trim() || null
    if (original && original !== confirmed) {
      ownersStripped += 1
    }
    if (item.owner === confirmed) return [item]
    return [{ ...item, owner: confirmed }]
  })

  const sections = content.sections.flatMap((section) => {
    const keepItem = (item: NoteItem): boolean => {
      const verdict = verdicts.get(sectionClaimId(section.id, item.id))
      if (!verdict) return true
      if (verdict.verdict === 'unsupported' || verdict.verdict === 'proposed') {
        dropped += 1
        return false
      }
      return true
    }
    const beforeCount = section.keyPoints.length + section.supportingDetails.length
    const keyPoints = section.keyPoints.filter(keepItem)
    const supportingDetails = section.supportingDetails.filter(keepItem)
    if (keyPoints.length === 0 && supportingDetails.length === 0) {
      return beforeCount === 0 ? [section] : []
    }
    return [{ ...section, keyPoints, supportingDetails }]
  })

  return {
    content: {
      ...content,
      keyTakeaways,
      nextSteps,
      sections
    },
    dropped,
    ownersStripped
  }
}

export function appendUncoveredLedger(
  content: MeetingNotesContent,
  ledger: readonly LedgerEntry[],
  cap = COVERAGE_APPEND_CAP
): { content: MeetingNotesContent; appended: number } {
  if (content.sections.length === 0 || ledger.length === 0 || cap <= 0) {
    return { content, appended: 0 }
  }

  const ordered = [...ledger].sort((left, right) => ledgerPriority(left.kind) - ledgerPriority(right.kind))
  const sections = content.sections.map((section) => ({
    ...section,
    keyPoints: [...section.keyPoints],
    supportingDetails: [...section.supportingDetails]
  }))
  let working: MeetingNotesContent = { ...content, sections }
  let appended = 0

  for (const entry of ordered) {
    // Ticket-ID entries are few and high-value; they bypass the append cap so
    // LLM-extracted entries cannot crowd them out.
    const isTicketEntry = ticketIdsInText(entry.text).length > 0
    if (!isTicketEntry && appended >= cap) break
    if (documentCoversLedgerEntry(entry, flattenNotesText(working))) continue
    const sectionIndex = bestSectionIndex(working.sections, `${entry.text} ${entry.quote}`)
    const section = working.sections[sectionIndex]
    if (!section) continue
    const text = coverageItemText(entry)
    const item: NoteItem = {
      id: scanItemId('detail', `\n${text}`),
      title: null,
      topic: section.title,
      owner: null,
      deadline: null,
      text,
      sources: [{ startMs: entry.startMs, endMs: entry.endMs }],
      provenance: 'generated',
      completed: false
    }
    const nextSections = working.sections.map((row, index) =>
      index === sectionIndex
        ? { ...row, supportingDetails: [...row.supportingDetails, item] }
        : row
    )
    working = { ...working, sections: nextSections }
    appended += 1
  }

  return { content: working, appended }
}

async function generateJsonArray(
  generate: EvidenceGenerateFn,
  prompt: string,
  seed: number
): Promise<unknown[] | null> {
  const request = (nextSeed: number): EvidenceGenerateRequest => ({
    prompt,
    num_ctx: 4096,
    num_predict: 512,
    temperature: 0,
    seed: nextSeed,
    stop: []
  })
  const first = extractJsonArray(await generate(request(seed)))
  if (first) return first
  return extractJsonArray(await generate(request(seed + 1)))
}

export async function extractLedger(
  chunks: readonly TranscriptChunk[],
  generate: EvidenceGenerateFn,
  seed: number
): Promise<{ ledger: LedgerEntry[]; chunksFailed: number }> {
  const ledger: LedgerEntry[] = []
  let chunksFailed = 0
  for (const chunk of chunks) {
    const parsed = await generateJsonArray(generate, buildLedgerPrompt(chunk.text), seed)
    if (!parsed) {
      chunksFailed += 1
      continue
    }
    ledger.push(
      ...filterLedgerEntries(parsed, chunk.text, { startMs: chunk.startMs, endMs: chunk.endMs })
    )
  }
  return { ledger: dedupeLedger(ledger), chunksFailed }
}

export async function verifyClaims(
  claims: readonly EvidenceClaim[],
  rows: readonly TranscriptRow[],
  generate: EvidenceGenerateFn,
  seed: number
): Promise<{ verdicts: Map<string, ClaimVerdictRecord>; checked: number; unvalidated: number }> {
  const verdicts = new Map<string, ClaimVerdictRecord>()
  let unvalidated = 0
  for (let index = 0; index < claims.length; index += CLAIM_BATCH_SIZE) {
    const batch = claims.slice(index, index + CLAIM_BATCH_SIZE)
    const prepared = batch.map((claim) => ({
      claim,
      windows: retrieveEvidenceWindows(claim.text, rows)
    }))
    const parsed = await generateJsonArray(generate, buildVerificationPrompt(prepared), seed)
    if (!parsed) {
      unvalidated += batch.length
      continue
    }
    const byId = new Map<string, ClaimVerdictRecord>()
    for (const row of parsed) {
      if (row === null || typeof row !== 'object') continue
      const record = row as { id?: unknown; verdict?: unknown; owner?: unknown }
      if (typeof record.id !== 'string' || !record.id) continue
      const verdict = asVerdict(record.verdict)
      if (!verdict) continue
      byId.set(record.id, { id: record.id, verdict, owner: asOwner(record.owner) })
    }
    for (const claim of batch) {
      const verdict = byId.get(claim.id)
      if (!verdict) {
        unvalidated += 1
        continue
      }
      verdicts.set(claim.id, verdict)
    }
  }
  return { verdicts, checked: verdicts.size, unvalidated }
}

export async function validateNotesAgainstTranscript(
  content: MeetingNotesContent,
  transcript: readonly TranscriptRow[],
  generate: EvidenceGenerateFn,
  seed: number
): Promise<{ content: MeetingNotesContent; stats: NotesValidationStats }> {
  if (transcript.length === 0) {
    return { content, stats: emptyValidationStats(false) }
  }

  const chunks = chunkTranscript(transcript)
  const extracted = await extractLedger(chunks, generate, seed)
  const ledger = supplementLedgerTickets(extracted.ledger, transcript)
  const claims = collectEvidenceClaims(content)
  const verified = await verifyClaims(claims, transcript, generate, seed)
  const applied = applyClaimVerdicts(content, verified.verdicts)
  const covered = appendUncoveredLedger(applied.content, ledger)

  return {
    content: covered.content,
    stats: {
      ran: true,
      error: null,
      ledgerChunksFailed: extracted.chunksFailed,
      claimsChecked: verified.checked,
      claimsDropped: applied.dropped,
      ownersStripped: applied.ownersStripped,
      ledgerAppends: covered.appended,
      unvalidatedClaims: verified.unvalidated
    }
  }
}
