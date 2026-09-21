/**
 * Deterministic coverage scoring against a material-fact key.md table.
 * Synthetic-safe: markers come from the key file, not a meeting-specific list.
 */

import { extractFacts, missingFacts } from './facts.ts'

export interface CoverageItem {
  id: string
  type: string
  claim: string
  grounded: boolean
}

export type CoverageStatus = 'present' | 'partial' | 'absent'

export interface ItemScore {
  id: string
  type: string
  status: CoverageStatus
}

export interface CoverageScore {
  n: number
  present: number
  partial: number
  absent: number
  strict: number
  credit: number
  items: ItemScore[]
}

const KEYWORD_STOP = new Set([
  'that',
  'this',
  'with',
  'from',
  'into',
  'after',
  'before',
  'during',
  'about',
  'over',
  'under',
  'most',
  'some',
  'each',
  'every',
  'other',
  'more',
  'less',
  'very',
  'still',
  'once',
  'next',
  'last',
  'first',
  'also',
  'just',
  'than',
  'then',
  'when',
  'what',
  'which',
  'where',
  'will',
  'would',
  'could',
  'should',
  'must',
  'have',
  'been',
  'being',
  'were',
  'they',
  'them',
  'their',
  'there',
  'here',
  'into',
  'onto',
  'only',
  'both',
  'same',
  'make',
  'made',
  'need',
  'needs',
  'using',
  'used',
  'user',
  'users',
  'team',
  'yes',
  'not'
])

function cellsOf(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length < 4) return null
  const id = cells[0] ?? ''
  if (!/^K\d+$/u.test(id)) return null
  return cells
}

function isGrounded(cell: string): boolean {
  const normalized = cell.replace(/\*/gu, '').trim().toLowerCase()
  return normalized.startsWith('yes')
}

export function parseCoverageKey(markdown: string): CoverageItem[] {
  const items: CoverageItem[] = []
  for (const line of markdown.split(/\r?\n/u)) {
    const cells = cellsOf(line)
    if (!cells) continue
    items.push({
      id: cells[0] ?? '',
      type: (cells[1] ?? '').replace(/\*/gu, '').trim().toLowerCase(),
      claim: (cells[2] ?? '').replace(/\*\*/gu, '').trim(),
      grounded: isGrounded(cells[3] ?? '')
    })
  }
  return items
}

export function groundedItems(items: readonly CoverageItem[]): CoverageItem[] {
  return items.filter((item) => item.grounded)
}

export function distinctiveKeywords(claim: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of claim.toLowerCase().split(/[^a-z0-9+]+/u)) {
    if (raw.length < 4) continue
    if (/^\d/.test(raw)) continue
    if (KEYWORD_STOP.has(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

export function scoreItem(claim: string, document: string): CoverageStatus {
  const facts = extractFacts(claim)
  const missing = missingFacts(claim, document)
  const numbersHit = facts.numbers.length - missing.numbers.length
  const namesHit = facts.names.length - missing.names.length
  const keywords = distinctiveKeywords(claim)
  const haystack = document.toLowerCase()
  const kwHit = keywords.filter((word) => haystack.includes(word)).length

  const numberScore = facts.numbers.length === 0 ? 1 : numbersHit / facts.numbers.length
  const nameScore = facts.names.length === 0 ? 1 : namesHit / facts.names.length
  const kwScore = keywords.length === 0 ? 1 : kwHit / keywords.length

  if (numberScore === 1 && nameScore >= 0.5 && kwScore >= 0.4) return 'present'
  if (numbersHit + namesHit + kwHit === 0) return 'absent'
  if (numberScore >= 0.5 || nameScore >= 0.5 || kwScore >= 0.25) return 'partial'
  return 'absent'
}

export function scoreCoverage(
  document: string,
  items: readonly CoverageItem[]
): CoverageScore {
  const grounded = groundedItems(items)
  const scored: ItemScore[] = grounded.map((item) => ({
    id: item.id,
    type: item.type,
    status: scoreItem(item.claim, document)
  }))
  const present = scored.filter((item) => item.status === 'present').length
  const partial = scored.filter((item) => item.status === 'partial').length
  const absent = scored.filter((item) => item.status === 'absent').length
  const n = scored.length
  return {
    n,
    present,
    partial,
    absent,
    strict: n === 0 ? 0 : present / n,
    credit: n === 0 ? 0 : (present + 0.5 * partial) / n,
    items: scored
  }
}
