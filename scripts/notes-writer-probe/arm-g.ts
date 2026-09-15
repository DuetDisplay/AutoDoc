/**
 * Arm G: deterministic redundancy-removal on a composed notes document.
 * Passes run in order: id-leak repair, NS-vs-Decisions, within-NS cluster,
 * filler strip, past-tense demotion, misfiled-group repair, fragment fusion,
 * motivation drop, cross-group body dedup, footer presentation (closed
 * decisions inline as Agreed children; Next Steps is the only footer). Body repair
 * passes treat each group as atomic (parent + children). Pass 2 may fall back to one
 * grouping-only model call on small meetings that still under-merge.
 */

import { CATALOG_ITEM_ID_PATTERN, containsCatalogItemId } from './arm-e.ts'
import { joinNotesDocument, sectionBody, splitNotesDocument, type NotesChunk } from './arm-f.ts'
import {
  ARM_G_GROUP_MODEL,
  ARM_G_GROUP_NUM_CTX,
  ARM_G_GROUP_NUM_PREDICT,
  ARM_G_GUARD_VERSION,
  DEFAULT_SEED,
  STOP_CONDITIONS
} from './constants.ts'
import { parseCoverageKey, scoreCoverage, type CoverageItem, type CoverageScore } from './coverage.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_G_NS_GROUP_TEMPLATE, fillTemplate } from './prompts.ts'

export { ARM_G_GUARD_VERSION, ARM_G_GROUP_MODEL }
import { extractFacts, extractNumbers, extractProperNames, isNameStop, missingFacts } from './facts.ts'
import { countWords } from './tokens.ts'

/** Tuned on Arm F M1/M2 candidates. Frozen after calibration. */
export const NS_DECISION_JACCARD = 0.6
export const NS_CLUSTER_JACCARD = 0.45
export const NS_CLUSTER_SHARED_FACT_JACCARD = 0.35
/** Workstream clustering (pass 2). Tuned so M2 notes-refactor items connect. */
export const NS_WORKSTREAM_JACCARD = 0.2
export const NS_WORKSTREAM_OVERLAP = 0.28
export const NS_WORKSTREAM_TITLE_SHARED = 2
export const NS_WORKSTREAM_DISTINCTIVE = 2
export const NS_WORKSTREAM_TITLE_ANCHOR_LEN = 10
export const NS_MODEL_GROUP_THRESHOLD = 6
/** Only M2-sized meetings may use the grouping model; M1 should stay ~10–12 items. */
export const NS_MODEL_INPUT_MAX = 12
export const DECISION_NEAR_DUP_JACCARD = 0.45
export const GROUP_SUBSET_TOKEN_RATIO = 0.7
export const GROUP_PARTIAL_TOKEN_RATIO = 0.35
export const GROUP_PARTIAL_SHARED_NAME_RATIO = 0.22
export const BODY_ALREADY_PRESENT_RATIO = 0.5

/**
 * Obligation markers that mean work is still open, not a closed decision.
 * Matches the Rule A future-tense list: will / should / need to / must / going to.
 */
const FUTURE_OBLIGATION = /\b(?:will|should|must|going to|need to|needs to)\b/iu

/**
 * Infinitive of unfinished work ("to create a ticket", "to review the PR").
 * Verbs are the Rule A unfinished-work set, not a meeting-fitted list.
 */
const TO_UNFINISHED_WORK =
  /\bto\s+(?:creat|add|review|research|implement|investigat|configur|send|updat|ticket)\w*\b/iu

/** Titles that name remaining work rather than a settled choice. */
const OPEN_WORK_TITLE = /^(?:next steps\b|create ticket\b)/iu

/**
 * Cleaned titles that still start with an unfinished-work verb are open work,
 * even without an owner or "will".
 */
const IMPERATIVE_OPEN_TITLE =
  /^(?:reconsider|customize|change|review|research|implement|investigate|add|create|update|configure|send)\w*\b/iu

/** Leftover title words that name the slot, not the choice. */
const DECISION_TITLE_NOISE = /\b(?:next steps for|decision|clarified|decided|agreed)\b/giu

/** Closed-choice complement: "the team decided to X" / "agreed that X". */
const CLOSED_CHOICE_COMPLEMENT =
  /\b(?:the team\s+)?(?:decided|agreed)\s+(?:to|that)\s+(.+)/iu

/**
 * camelCase product tokens the Title-Case name extractor misses because they
 * start lowercase (iPad). Not a meeting list — any [a-z]+[A-Z]… token.
 */
const CAMEL_PRODUCT = /\b[a-z]+[A-Z][A-Za-z]+\b/gu

/**
 * Alphanumeric identifiers that carry a digit (blackjack130). The name
 * extractor skips these; the number extractor skips the letters.
 */
const ALNUM_IDENTIFIER = /\b[A-Za-z]+\d[A-Za-z0-9]*\b/gu

/**
 * Calendar leftover phrases only. The broader DEADLINE_PATTERN also matches
 * "by the team", which is not a date and must not become a parenthetical.
 */
const LEFTOVER_DEADLINE =
  /\b(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of \w+|\d+\s*(?:days?|weeks?|hours?)|a week(?:['’]s worth)?|this week|next week|august|september|october|november|december|january|february|march|april|june|july)\b/giu

/**
 * Common nouns that Title-Case extractors treat as names (Century Log).
 * Leftover parentheticals keep identity-bearing names only.
 */
const LEFTOVER_COMMON_NOUN = new Set([
  'log',
  'report',
  'channel',
  'system',
  'process',
  'dashboard',
  'account',
  'limit',
  'rate',
  'latency',
  'collision',
  'collisions',
  'error',
  'issue',
  'service',
  'update',
  'ticket',
  'step',
  'task'
])

/** Verb stems GENERIC_VERBS does not already cover, used only to reject leftover names. */
const LEFTOVER_EXTRA_VERB = /^(identif|rais|notif)/iu

const PLACEHOLDER_OWNER = /^(owner|me|them|us|we|all|everyone|everybody)$/iu

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'may',
  'might',
  'not',
  'of',
  'on',
  'or',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'will',
  'with',
  'would',
  'you',
  'your',
  'vs',
  'versus',
  'also',
  'more',
  'most',
  'some',
  'very',
  'into',
  'over',
  'under',
  'about',
  'after',
  'before',
  'during',
  'only',
  'both',
  'same',
  'into',
  'onto'
])

const COMPARATIVE_STOP = new Set([
  'offers',
  'lacks',
  'enables',
  'depends',
  'relies',
  'alongside',
  'especially',
  'current',
  'leading',
  'improve',
  'improving',
  'including'
])

const CLUSTER_STOP = new Set([
  ...STOPWORDS,
  ...COMPARATIVE_STOP,
  'currently',
  'working',
  'plans',
  'allow',
  'others',
  'public',
  'easier',
  'efficient',
  'efficiency',
  'which',
  'them',
  'their',
  'task',
  'step',
  'steps',
  'next',
  'follow',
  'using',
  'used',
  'need',
  'needs',
  'team',
  'care',
  'rest',
  'related',
  'requested',
  'stated',
  'suggested',
  'proposed',
  'observed',
  'emphasized',
  'possible',
  'otherwise',
  'similar',
  'taking',
  'ownership',
  'part',
  'everybody',
  'everyone',
  'setup',
  'aimed',
  'experience',
  'purposes',
  'purpose',
  'limited',
  'hinders',
  'future',
  'until',
  'complete',
  'steady',
  'slow',
  'focus',
  'expected',
  'duration',
  'several',
  'including',
  'within',
  'through',
  'into',
  'onto',
  'also',
  'just'
])

const GENERIC_VERBS = new Set([
  'review',
  'add',
  'implement',
  'investigat',
  'update',
  'creat',
  'send',
  'work',
  'need',
  'plan',
  'allow',
  'provid',
  'gather',
  'evaluat',
  'make',
  'take',
  'use',
  'set',
  'check',
  'keep',
  'help',
  'start',
  'give',
  'ensur',
  'configur',
  'stand',
  'talk',
  'leav',
  'address',
  'improv',
  'resolv',
  'detect',
  'approv',
  'record',
  'ask',
  'includ',
  'stay',
  'test'
])

/** Shared process words that must not glue unrelated workstreams together. */
const WEAK_CLUSTER_LEMMAS = new Set([
  'alert',
  'error',
  'issue',
  'user',
  'member',
  'people',
  'person',
  'system',
  'critical',
  'confirm',
  'context',
  'monitor',
  'assign',
  'avoid',
  'option',
  'access',
  'account',
  'downtim',
  'downtime',
  'channel',
  'dashboard',
  'setup',
  'coverage',
  'solution',
  'item',
  'file',
  'new',
  'real',
  'adde',
  'ensure',
  'server'
])

/** Title-only product names that identify one deliverable even without a second lemma. */
const PRODUCT_TITLE_LEMMAS = new Set(['slack', 'android', 'brevo', 'uptimerobot'])

/** Owner + this lemma is enough: same technical identity, not a process word. */
const IDENTITY_LEMMAS = new Set(['guid'])

const DEADLINE_PATTERN =
  /\b(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of \w+|by (?:the )?(?:end of )?\w+|\d+\s*(?:days?|weeks?|hours?)|a week(?:['’]s worth)?|this week|next week|august|september|october|november|december|january|february|march|april|june|july)\b/giu

const TOKEN_ALIASES: Record<string, string> = {
  sms: 'sms',
  mixpanel: 'mixpanel',
  mixpanels: 'mixpanel',
  alerts: 'alert',
  alert: 'alert',
  notifications: 'alert',
  notification: 'alert',
  phones: 'phone',
  phone: 'phone',
  users: 'user',
  user: 'user',
  outage: 'downtime',
  outages: 'downtime',
  downtime: 'downtime',
  offhours: 'downtime',
  nights: 'downtime',
  weekends: 'downtime',
  unavailability: 'downtime'
}

const FILLER_PATTERNS: readonly RegExp[] = [
  /\bthe exact timeline\b[^.]*\.?/giu,
  /\bthis is (?:a )?(?:crucial|high-priority|considered essential)\b[^.]*\.?/giu,
  /\b(?:but\s+)?it['’]?s considered essential nonetheless\.?/giu,
  /\bthis is a crucial step in streamlining operations\b[^.]*\.?/giu,
  /\bthis is a high-priority task aimed at improving\b[^.]*\.?/giu,
  /\bthis task has been ongoing since\b[^.]*\.?/giu
]

const RATIONALE_PREFIX = /^\s*rationale:\s*/iu

const PAST_COMPLETION: readonly RegExp[] = [
  /\bimplemented\b/iu,
  /\bconfirmed\b/iu,
  /\breached out\b/iu,
  /\bidentified\b/iu
]

const FORWARD_LOOKING =
  /\b(?:will|we['’]ll|i['’]ll|wants? to|plans? to|need to|needs to|should|going to|before (?:the )?(?:release|deadline)|to be (?:done|addressed|reviewed)|by end of|due)\b/iu

export interface ActionItem {
  title: string
  owners: string[]
  body: string
}

export interface BulletGroup {
  title: string
  children: string[]
}

export interface TopicalSection {
  name: string
  groups: BulletGroup[]
}

export interface ParsedNotes {
  prefix: string
  topical: TopicalSection[]
  decisions: ActionItem[]
  nextSteps: ActionItem[]
  hasDecisionsHeading: boolean
  hasNextStepsHeading: boolean
  trailingNewline: boolean
}

export type PassName =
  | 'id-leak-repair'
  | 'ns-vs-decisions'
  | 'within-ns-cluster'
  | 'filler-strip'
  | 'past-tense-demotion'
  | 'misfiled-child-repair'
  | 'fragment-fusion'
  | 'motivation-drop'
  | 'cross-group-body-dedup'
  | 'sibling-paraphrase'
  | 'footer-presentation'

export interface PassChange {
  pass: PassName
  action: string
  before: string
  after: string | null
}

export interface PassReport {
  name: PassName
  wordsBefore: number
  wordsAfter: number
  wordsRemoved: number
  changes: PassChange[]
}

export type NsGroupingPath = 'deterministic' | 'model'

export interface ArmGReport {
  inputWordCount: number
  outputWordCount: number
  wordsRemoved: number
  nextStepsBefore: number
  nextStepsAfter: number
  decisionsBefore: number
  decisionsAfter: number
  nsGroupingPath: NsGroupingPath
  passes: PassReport[]
  sectionWordCounts: Record<string, number>
  smsSlackCaught: boolean
}

export interface ApplyArmGOptions {
  nsIndexGroups?: number[][]
  nsGroupingPath?: NsGroupingPath
  sourceCatalog?: Readonly<Record<string, string>>
}

export interface ArmGResult {
  markdown: string
  report: ArmGReport
}

export interface ArmGGates {
  coveragePass: boolean
  coverageInputStrict: number
  coverageOutputStrict: number
  namesNumbersPass: boolean
  missingNames: string[]
  missingNumbers: string[]
  ownersPass: boolean
  inputOwners: string[]
  outputOwners: string[]
  missingOwners: string[]
  structurePass: boolean
  hasDecisions: boolean
  hasNextSteps: boolean
  nextStepsAllBolded: boolean
  allPass: boolean
}

function uniquePreserve(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key) || key.length === 0) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function canonicalizePhrase(text: string): string {
  return text
    .replace(/\btext messages?\b/giu, 'sms')
    .replace(/\bmix\s*panels?\b/giu, 'mixpanel')
    .replace(/\boff[-\s]?hours\b/giu, 'offhours')
    .replace(/\buptime\s+robot\b/giu, 'uptimerobot')
}

export function contentTokenSet(text: string, extraStop: ReadonlySet<string> = STOPWORDS): Set<string> {
  const prepared = canonicalizePhrase(text).toLowerCase()
  const matches = prepared.match(/[a-z0-9]+/gu) ?? []
  const tokens = new Set<string>()
  for (const raw of matches) {
    if (raw.length < 3) continue
    if (extraStop.has(raw) || COMPARATIVE_STOP.has(raw)) continue
    tokens.add(TOKEN_ALIASES[raw] ?? raw)
  }
  return tokens
}

export function lightStem(token: string): string {
  const aliased = TOKEN_ALIASES[token] ?? token
  if (aliased.length < 5) return aliased
  if (aliased.endsWith('ational') && aliased.length > 9) return `${aliased.slice(0, -7)}e`
  if (aliased.endsWith('ation') && aliased.length > 7) return aliased.slice(0, -5)
  if (aliased.endsWith('ing') && aliased.length > 5) {
    const base = aliased.slice(0, -3)
    return base.endsWith('e') || base.length < 4 ? (base.endsWith('e') ? base : `${base}e`) : base
  }
  if (aliased.endsWith('ed') && aliased.length > 4) {
    const withoutEd = aliased.slice(0, -2)
    return withoutEd.endsWith('e') ? aliased.slice(0, -1) : withoutEd
  }
  if (aliased.endsWith('ies') && aliased.length > 5) return `${aliased.slice(0, -3)}y`
  if (aliased.endsWith('s') && !aliased.endsWith('ss') && aliased.length > 3) return aliased.slice(0, -1)
  if (aliased.endsWith('e') && aliased.length > 6) return aliased.slice(0, -1)
  return aliased
}

export function contentLemmaSet(text: string): Set<string> {
  const prepared = canonicalizePhrase(stripFillerText(text, null)).toLowerCase()
  const matches = prepared.match(/[a-z0-9]+/gu) ?? []
  const lemmas = new Set<string>()
  for (const raw of matches) {
    if (raw.length < 3) continue
    if (CLUSTER_STOP.has(raw)) continue
    lemmas.add(lightStem(raw))
  }
  return lemmas
}

export function itemLemmaSet(item: ActionItem): Set<string> {
  return contentLemmaSet(`${item.title} ${stripFillerText(item.body, item.title)}`)
}

function ownerNameLemmas(items: readonly ActionItem[]): Set<string> {
  const names = new Set<string>()
  for (const item of items) {
    for (const owner of item.owners) {
      const lower = owner.toLowerCase()
      names.add(lower)
      names.add(lightStem(lower))
    }
  }
  return names
}

export function distinctiveContentLemmas(text: string): Set<string> {
  return distinctiveLemmas(contentLemmaSet(text))
}

function distinctiveLemmas(lemmas: Set<string>, exclude: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>()
  for (const lemma of lemmas) {
    if (GENERIC_VERBS.has(lemma)) continue
    if (WEAK_CLUSTER_LEMMAS.has(lemma)) continue
    if (exclude.has(lemma)) continue
    if (lemma.length < 4) continue
    out.add(lemma)
  }
  return out
}

function sharedCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const lemma of left) {
    if (right.has(lemma)) count += 1
  }
  return count
}

export function overlapCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  return sharedCount(left, right) / Math.min(left.size, right.size)
}

export function relatedByWorkstream(left: ActionItem, right: ActionItem): boolean {
  const ownerExclude = ownerNameLemmas([left, right])
  const leftLemmas = itemLemmaSet(left)
  const rightLemmas = itemLemmaSet(right)
  const leftDistinct = distinctiveLemmas(leftLemmas, ownerExclude)
  const rightDistinct = distinctiveLemmas(rightLemmas, ownerExclude)
  const sharedDistinct = sharedCount(leftDistinct, rightDistinct)
  const fullScore = jaccard(leftLemmas, rightLemmas)
  const overlap = overlapCoefficient(leftLemmas, rightLemmas)
  const leftTitle = distinctiveLemmas(contentLemmaSet(left.title), ownerExclude)
  const rightTitle = distinctiveLemmas(contentLemmaSet(right.title), ownerExclude)
  const titleShared = sharedCount(leftTitle, rightTitle)
  if (titleShared >= NS_WORKSTREAM_TITLE_SHARED) return true
  if (titleShared >= 1) {
    for (const lemma of leftTitle) {
      if (!rightTitle.has(lemma)) continue
      if (lemma.length >= NS_WORKSTREAM_TITLE_ANCHOR_LEN || PRODUCT_TITLE_LEMMAS.has(lemma)) return true
    }
  }
  if (sharedDistinct >= NS_WORKSTREAM_DISTINCTIVE && fullScore >= NS_WORKSTREAM_JACCARD) return true
  if (sharedDistinct >= NS_WORKSTREAM_DISTINCTIVE && overlap >= NS_WORKSTREAM_OVERLAP) return true
  const sharedOwners = left.owners.some((owner) =>
    right.owners.some((other) => other.toLowerCase() === owner.toLowerCase())
  )
  if (sharedOwners && sharedDistinct >= NS_WORKSTREAM_DISTINCTIVE) return true
  if (sharedOwners) {
    for (const lemma of leftDistinct) {
      if (rightDistinct.has(lemma) && IDENTITY_LEMMAS.has(lemma)) return true
    }
  }
  return false
}

export function relatedNearDuplicate(left: ActionItem, right: ActionItem): boolean {
  if (normalizeTitle(left.title) === normalizeTitle(right.title) && normalizeTitle(left.title).length > 0) {
    return true
  }
  const titleScore = jaccard(contentTokenSet(left.title), contentTokenSet(right.title))
  if (titleScore >= NS_DECISION_JACCARD) return true
  const fullScore = jaccard(contentTokenSet(itemText(left)), contentTokenSet(itemText(right)))
  if (fullScore >= DECISION_NEAR_DUP_JACCARD) return true
  return relatedByWorkstream(left, right) && titleScore >= 0.35
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

export function containment(inner: Set<string>, outer: Set<string>): number {
  if (inner.size === 0) return 0
  let hit = 0
  for (const token of inner) {
    if (outer.has(token)) hit += 1
  }
  return hit / inner.size
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function itemText(item: ActionItem): string {
  return `${item.title} ${item.body}`.trim()
}

function groupText(group: BulletGroup): string {
  return [group.title, ...group.children].filter((row) => row.trim().length > 0).join('\n')
}

function splitOwners(raw: string): string[] {
  return raw
    .split(/[,/&]|\band\b/iu)
    .map((part) => part.replace(/^[,.\s]+|[,.\s]+$/gu, '').replace(/^owner\s*:?\s*/iu, '').trim())
    .filter((part) => part.length > 0 && !PLACEHOLDER_OWNER.test(part))
}

function looksLikeOwnerSlot(raw: string): boolean {
  const cleaned = raw.replace(/^[,.\s]+|[,.\s]+$/gu, '').trim()
  if (cleaned.length === 0 || cleaned.length > 48) return false
  if (PLACEHOLDER_OWNER.test(cleaned)) return false
  if (/^[A-Z]{2,5}s?$/u.test(cleaned)) return false
  return /[\p{L}]/u.test(cleaned)
}

export function parseActionBullet(line: string): ActionItem {
  const stripped = line.replace(/^\s*[-*]\s+/u, '').trim()
  const bold = stripped.match(/^\*\*(.+?)\*\*\s*(.*)$/u)
  const title = (bold ? bold[1] : stripped).replace(/\.+$/u, '').trim()
  let rest = bold ? (bold[2] ?? '').trim() : ''
  const owners: string[] = []

  const leadOwner = rest.match(/^\(([^)]*)\)\s*(.*)$/u)
  if (leadOwner && looksLikeOwnerSlot(leadOwner[1] ?? '')) {
    owners.push(...splitOwners(leadOwner[1] ?? ''))
    rest = (leadOwner[2] ?? '').trim()
  }

  rest = rest.replace(/^(?:—|--|-)\s*/u, '').trim()

  const trailOwner = rest.match(/^(.*)\s+\(([^)]*)\)\s*$/u)
  if (trailOwner && looksLikeOwnerSlot(trailOwner[2] ?? '')) {
    owners.push(...splitOwners(trailOwner[2] ?? ''))
    rest = (trailOwner[1] ?? '').trim()
  }

  return {
    title: title.length > 0 ? title : rest.slice(0, 80),
    owners: uniquePreserve(owners),
    body: rest
  }
}

export function renderActionBullet(item: ActionItem, marker = '*'): string {
  const title = item.title.trim() || 'Follow up'
  const owner = item.owners.length > 0 ? ` (${item.owners.join(', ')})` : ''
  const body = item.body.trim()
  const rationale = body.length > 0 ? ` — ${body}` : ''
  return `${marker} **${title}**${owner}${rationale}`
}

export function parseActionItems(section: string): ActionItem[] {
  const items: ActionItem[] = []
  for (const line of section.split(/\r?\n/u)) {
    if (!/^\s*[-*]\s+/u.test(line)) continue
    const item = parseActionBullet(line)
    if (item.title.trim().length === 0 && item.body.trim().length === 0) continue
    items.push(item)
  }
  return items
}

export function parseBulletGroups(body: string): BulletGroup[] {
  const groups: BulletGroup[] = []
  let current: BulletGroup | null = null
  for (const line of body.split(/\r?\n/u)) {
    const top = /^(?:[-*])\s+(.*)$/u.exec(line)
    if (top) {
      current = { title: (top[1] ?? '').trim(), children: [] }
      groups.push(current)
      continue
    }
    const child = /^\s+[-*]\s+(.*)$/u.exec(line)
    if (child && current) {
      const text = (child[1] ?? '').trim()
      if (text.length > 0) current.children.push(text)
    }
  }
  return groups
}

export function renderBulletGroups(groups: readonly BulletGroup[]): string {
  const blocks: string[] = []
  for (const group of groups) {
    if (group.title.trim().length === 0 && group.children.length === 0) continue
    const lines = [`- ${group.title.trim()}`]
    for (const child of group.children) {
      if (child.trim().length === 0) continue
      lines.push(` - ${child.trim()}`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n')
}

export function parseNotes(markdown: string): ParsedNotes {
  const chunks = splitNotesDocument(markdown)
  const prefix = chunks.find((chunk) => chunk.kind === 'prefix')?.raw ?? ''
  const topical: TopicalSection[] = []
  let decisions: ActionItem[] = []
  let nextSteps: ActionItem[] = []
  let hasDecisionsHeading = false
  let hasNextStepsHeading = false
  for (const chunk of chunks) {
    if (chunk.kind === 'topical') {
      topical.push({
        name: chunk.name ?? 'Notes',
        groups: parseBulletGroups(sectionBody(chunk.raw))
      })
    } else if (chunk.kind === 'decisions') {
      hasDecisionsHeading = true
      decisions = parseActionItems(sectionBody(chunk.raw))
    } else if (chunk.kind === 'nextSteps') {
      hasNextStepsHeading = true
      nextSteps = parseActionItems(sectionBody(chunk.raw))
    }
  }
  return {
    prefix,
    topical,
    decisions,
    nextSteps,
    hasDecisionsHeading,
    hasNextStepsHeading,
    trailingNewline: markdown.endsWith('\n')
  }
}

export function renderNotes(doc: ParsedNotes): string {
  const chunks: NotesChunk[] = []
  if (doc.prefix.trim().length > 0) {
    chunks.push({ kind: 'prefix' as const, name: null, raw: doc.prefix.endsWith('\n') ? doc.prefix : `${doc.prefix}\n` })
  }
  for (const section of doc.topical) {
    const body = renderBulletGroups(section.groups)
    if (body.trim().length === 0) continue
    chunks.push({
      kind: 'topical' as const,
      name: section.name,
      raw: `## ${section.name}\n${body}\n`
    })
  }
  if (doc.decisions.length > 0) {
    const body = doc.decisions.map((item) => renderActionBullet(item)).join('\n')
    chunks.push({
      kind: 'decisions' as const,
      name: 'Decisions',
      raw: `## Decisions\n${body}\n`
    })
  }
  if (doc.hasNextStepsHeading || doc.nextSteps.length > 0) {
    const body = doc.nextSteps.map((item) => renderActionBullet(item)).join('\n')
    chunks.push({
      kind: 'nextSteps' as const,
      name: 'Next Steps',
      raw: `## Next Steps\n${body}\n`
    })
  }
  const joined = joinNotesDocument(chunks)
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

export function extractOwnerAttributions(items: readonly ActionItem[]): string[] {
  return uniquePreserve(items.flatMap((item) => item.owners))
}

function cloneItem(item: ActionItem): ActionItem {
  return { title: item.title, owners: [...item.owners], body: item.body }
}

function cloneGroup(group: BulletGroup): BulletGroup {
  return { title: group.title, children: [...group.children] }
}

function cloneDoc(doc: ParsedNotes): ParsedNotes {
  return {
    prefix: doc.prefix,
    topical: doc.topical.map((section) => ({
      name: section.name,
      groups: section.groups.map(cloneGroup)
    })),
    decisions: doc.decisions.map(cloneItem),
    nextSteps: doc.nextSteps.map(cloneItem),
    hasDecisionsHeading: doc.hasDecisionsHeading,
    hasNextStepsHeading: doc.hasNextStepsHeading,
    trailingNewline: doc.trailingNewline
  }
}

function unionOwners(left: readonly string[], right: readonly string[]): string[] {
  return uniquePreserve([...left, ...right])
}

function moreSpecificTitle(left: string, right: string): string {
  const leftTokens = contentTokenSet(left)
  const rightTokens = contentTokenSet(right)
  if (leftTokens.size !== rightTokens.size) return leftTokens.size >= rightTokens.size ? left : right
  return left.length >= right.length ? left : right
}

function splitSentences(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  return trimmed
    .split(/(?<=[.!?])\s+/u)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
}

function sentenceHasProtectedFact(sentence: string): boolean {
  return extractProperNames(sentence).length > 0 || extractNumbers(sentence).length > 0
}

export function isFillerSentence(sentence: string): boolean {
  const trimmed = sentence.trim()
  if (trimmed.length === 0) return false
  if (sentenceHasProtectedFact(trimmed)) return false
  return FILLER_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(trimmed)
  })
}

function rationaleRestatesTitle(title: string, rationale: string): boolean {
  const titleTokens = contentTokenSet(title)
  const bodyTokens = contentTokenSet(rationale)
  if (bodyTokens.size === 0) return true
  return containment(bodyTokens, titleTokens) >= 0.7 || jaccard(titleTokens, bodyTokens) >= 0.5
}

export function stripFillerText(text: string, titleForRationale: string | null = null): string {
  let next = text.replace(RATIONALE_PREFIX, '').trim()
  if (titleForRationale && next.length > 0 && rationaleRestatesTitle(titleForRationale, next)) {
    if (!sentenceHasProtectedFact(next) || containment(contentTokenSet(next), contentTokenSet(titleForRationale)) >= 0.85) {
      if (!sentenceHasProtectedFact(next)) next = ''
    }
  }
  const kept: string[] = []
  for (const sentence of splitSentences(next)) {
    let working = sentence.replace(RATIONALE_PREFIX, '').trim()
    for (const pattern of FILLER_PATTERNS) {
      if (sentenceHasProtectedFact(working)) break
      pattern.lastIndex = 0
      working = working.replace(pattern, '').trim()
    }
    working = working.replace(/^[,;:\s]+/u, '').replace(/\s+/gu, ' ').trim()
    working = working.replace(/^but\s+/iu, '').replace(/\s+but$/iu, '').trim()
    if (working.length === 0 || /^but$/iu.test(working)) continue
    if (isFillerSentence(working)) continue
    kept.push(working)
  }
  return kept.join(' ')
}

function distinctSentences(sentences: readonly string[]): string[] {
  const kept: string[] = []
  for (const sentence of sentences) {
    const tokens = contentTokenSet(sentence)
    const duplicate = kept.some((existing) => {
      const existingTokens = contentTokenSet(existing)
      return (
        containment(tokens, existingTokens) >= 0.8 ||
        containment(existingTokens, tokens) >= 0.8 ||
        jaccard(tokens, existingTokens) >= 0.75
      )
    })
    if (duplicate) continue
    kept.push(sentence)
  }
  return kept
}

function clauseFactSet(clause: string): { lemmas: Set<string>; names: string[]; numbers: string[] } {
  return {
    lemmas: distinctiveContentLemmas(clause),
    names: extractProperNames(clause),
    numbers: extractNumbers(clause)
  }
}

function leftoverLemmaAllowed(lemma: string, extra: ReadonlySet<string> = new Set()): boolean {
  return (
    WEAK_CLUSTER_LEMMAS.has(lemma) ||
    GENERIC_VERBS.has(lemma) ||
    extra.has(lemma) ||
    lemma === 'deadline' ||
    lemma === lightStem('deadline')
  )
}

function clauseNearSubset(inner: string, outer: string, extraLeftover: ReadonlySet<string> = new Set()): boolean {
  const left = clauseFactSet(inner)
  const right = clauseFactSet(outer)
  if (left.lemmas.size === 0 && left.names.length === 0 && left.numbers.length === 0) return true
  for (const name of left.names) {
    if (!namePresentIn(name, new Set(right.names.map((row) => row.toLowerCase())), outer)) return false
  }
  for (const number of left.numbers) {
    if (!right.numbers.some((row) => row.toLowerCase() === number.toLowerCase()) && !outer.toLowerCase().includes(number.toLowerCase())) {
      return false
    }
  }
  for (const lemma of left.lemmas) {
    if (right.lemmas.has(lemma)) continue
    if (leftoverLemmaAllowed(lemma, extraLeftover)) continue
    return false
  }
  return true
}

function clauseKeepScore(clause: string): number {
  let score = extractNumbers(clause).length * 2
  if (extractProperNames(clause).length > 0) score += 1
  score += Math.min(clause.length, 80) / 80
  return score
}

function expandClauses(clauses: readonly string[]): string[] {
  const out: string[] = []
  for (const clause of clauses) {
    const parts = clause
      .split(/\s*;\s*/u)
      .flatMap((part) => part.split(/,(?=\s+(?:[A-Z]|with\b))/u))
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    out.push(...parts)
  }
  return out
}

export function dedupeClauses(clauses: readonly string[]): string[] {
  const kept: string[] = []
  for (const clause of expandClauses(clauses)) {
    const trimmed = clause.trim()
    if (trimmed.length === 0) continue
    const subsetOf = kept.findIndex((existing) => clauseNearSubset(trimmed, existing))
    if (subsetOf >= 0) continue
    const supersets = kept
      .map((existing, index) => (clauseNearSubset(existing, trimmed) ? index : -1))
      .filter((index) => index >= 0)
    if (supersets.length > 0) {
      const bestExisting = supersets.reduce((best, index) =>
        clauseKeepScore(kept[index]!) >= clauseKeepScore(kept[best]!) ? index : best
      )
      if (clauseKeepScore(trimmed) > clauseKeepScore(kept[bestExisting]!)) {
        kept[bestExisting] = trimmed
        for (const index of supersets.filter((row) => row !== bestExisting).sort((left, right) => right - left)) {
          kept.splice(index, 1)
        }
      }
      continue
    }
    kept.push(trimmed)
  }
  return kept
}

function mergeItemBodies(items: readonly ActionItem[]): string {
  const sentences = items.flatMap((item) => splitSentences(stripFillerText(item.body, item.title)))
  return dedupeClauses(
    distinctSentences(sentences).map((sentence) => (/[.!?]$/u.test(sentence) ? sentence : `${sentence}.`))
  ).join(' ')
}

function mergeActionItems(items: readonly ActionItem[]): ActionItem {
  const titles = items.map((item) => item.title)
  let title = titles[0] ?? 'Follow up'
  for (const candidate of titles.slice(1)) title = moreSpecificTitle(title, candidate)
  return {
    title,
    owners: uniquePreserve(items.flatMap((item) => item.owners)),
    body: mergeItemBodies(items)
  }
}

function factsOf(text: string): { names: Set<string>; numbers: Set<string> } {
  const facts = extractFacts(text)
  return {
    names: new Set(facts.names.map((name) => name.toLowerCase())),
    numbers: new Set(facts.numbers.map((number) => number.toLowerCase()))
  }
}

function namePresentIn(name: string, haystackNames: Set<string>, haystackText: string): boolean {
  const lowered = name.toLowerCase()
  if (haystackNames.has(lowered)) return true
  const hay = canonicalizePhrase(haystackText).toLowerCase()
  if (hay.includes(lowered)) return true
  const compactName = canonicalizePhrase(name).toLowerCase().replace(/\s+/gu, '')
  const compactHay = hay.replace(/\s+/gu, '')
  if (compactName.length >= 3 && compactHay.includes(compactName)) return true
  if (lowered === 'sms' && (/\bsms\b/u.test(hay) || /\btext messages?\b/u.test(haystackText.toLowerCase()))) {
    return true
  }
  return lowered.split(/\s+/u).every((token) => token.length === 0 || hay.includes(token))
}

function namesNumbersSubset(inner: string, outer: string): boolean {
  const innerFacts = extractFacts(inner)
  const outerFacts = factsOf(outer)
  for (const name of innerFacts.names) {
    if (!namePresentIn(name, outerFacts.names, outer)) return false
  }
  for (const number of innerFacts.numbers) {
    if (!outerFacts.numbers.has(number.toLowerCase()) && !canonicalizePhrase(outer).toLowerCase().includes(number.toLowerCase())) {
      return false
    }
  }
  return true
}

export function sharedKeyFacts(left: string, right: string, ownerNames: ReadonlySet<string>): number {
  const leftFacts = extractFacts(left)
  const rightFacts = factsOf(right)
  let shared = 0
  for (const name of leftFacts.names) {
    const key = name.toLowerCase()
    if (ownerNames.has(key)) continue
    if (key.replace(/\s+/gu, '').length < 3) continue
    if (namePresentIn(name, rightFacts.names, right)) shared += 1
  }
  for (const number of leftFacts.numbers) {
    if (rightFacts.numbers.has(number.toLowerCase())) shared += 1
  }
  return shared
}

function relatedNextSteps(left: ActionItem, right: ActionItem): boolean {
  return relatedByWorkstream(left, right)
}

function extractDeadlines(text: string): string[] {
  return uniquePreserve([...text.matchAll(DEADLINE_PATTERN)].map((match) => match[0] ?? '').filter(Boolean))
}

function titleHasNamedRecipient(item: ActionItem): boolean {
  return extractProperNames(item.title).some((name) => !GENERIC_VERBS.has(name.toLowerCase()))
}

export type ActionVerbClass = 'review' | 'configure' | 'build' | 'investigate'

const VERB_CLASS_LEMMAS: Record<ActionVerbClass, readonly string[]> = {
  review: ['review', 'approv', 'talk', 'discuss', 'meet'],
  configure: ['configur', 'tun', 'integrat', 'ensur', 'give', 'limit'],
  build: ['build', 'releas', 'refactor', 'updat', 'ship', 'test', 'record', 'gather'],
  investigate: ['investigat', 'research', 'explor', 'resolv']
}

function classifyVerbLemma(lemma: string): ActionVerbClass | null {
  for (const [cls, lemmas] of Object.entries(VERB_CLASS_LEMMAS) as [ActionVerbClass, readonly string[]][]) {
    if (lemmas.includes(lemma)) return cls
  }
  return null
}

function orderedContentLemmas(text: string): string[] {
  const prepared = canonicalizePhrase(stripFillerText(text, null)).toLowerCase()
  const matches = prepared.match(/[a-z0-9]+/gu) ?? []
  const out: string[] = []
  for (const raw of matches) {
    if (raw.length < 3) continue
    if (CLUSTER_STOP.has(raw)) continue
    out.push(lightStem(raw))
  }
  return out
}

export function itemVerbClass(item: ActionItem): ActionVerbClass | null {
  const title = item.title.replace(/^next steps\s+(?:for\s+)?/iu, '').replace(/^to\s+/iu, '')
  for (const lemma of orderedContentLemmas(title)) {
    const cls = classifyVerbLemma(lemma)
    if (cls) return cls
  }
  for (const lemma of orderedContentLemmas(item.body)) {
    const cls = classifyVerbLemma(lemma)
    if (cls) return cls
  }
  if (/\breview\b/iu.test(item.title)) return 'review'
  return null
}

function isPersonToken(name: string): boolean {
  if (PLACEHOLDER_OWNER.test(name)) return false
  if (name.length < 3) return false
  if (/^(brevo|github|android|google|slack|cursor|mixpanel|uptime|robot|guid|duet|autodoc|friday|august|thursday)$/iu.test(name)) {
    return false
  }
  return /^[A-Z][a-z]{2,}$/u.test(name)
}

export function impliedSplitOwners(item: ActionItem): string[] {
  if (item.owners.length > 0) return [...item.owners]
  const text = `${item.title}. ${item.body}`
  const found: string[] = []
  for (const match of text.matchAll(/\b([A-Z][a-z]{2,})(?:'s|\s+will\b)/gu)) {
    if (match[1] && isPersonToken(match[1])) found.push(match[1])
  }
  for (const match of text.matchAll(
    /\b(?:to|with)\s+([A-Z][a-z]{2,})(?:\s+and\s+([A-Z][a-z]{2,}))?\s+for\s+(?:integration|review|approval)\b/gu
  )) {
    if (match[1] && isPersonToken(match[1])) found.push(match[1])
    if (match[2] && isPersonToken(match[2])) found.push(match[2])
  }
  return uniquePreserve(found)
}

export function pickDeliverableTitle(items: readonly ActionItem[]): string {
  let best = items[0]?.title ?? 'Follow up'
  let bestScore = Number.NEGATIVE_INFINITY
  for (const item of items) {
    let score = contentLemmaSet(item.title).size
    if (titleHasNamedRecipient(item)) score += 5
    if (/\binternal\b/iu.test(item.title) && /\brelease|version|build\b/iu.test(item.title)) score += 3
    if (extractDeadlines(itemText(item)).length > 0) score += 2
    if (extractNumbers(item.title).length > 0) score += 2
    if (extractNumbers(item.title).length > 0 && itemVerbClass(item) === 'configure') score += 3
    if (/^next steps\b/iu.test(item.title)) score -= 4
    if (/^to\s+/iu.test(item.title)) score -= 1
    score += Math.min(item.title.length, 80) / 80
    if (score > bestScore) {
      bestScore = score
      best = item.title
    }
  }
  return best
}

function tidyClause(text: string): string {
  let working = stripFillerText(text, null).replace(/\s+/gu, ' ').trim()
  working = working.replace(/\bto\s*,\s*/giu, '')
  working = working.replace(/\s+,/gu, ',').replace(/,\s*,+/gu, ',').replace(/^[,;:\s]+|[,;:\s]+$/gu, '')
  working = working.replace(/\bemail who\b/giu, 'email that the recipient')
  if (working.length > 0 && !/[.!?]$/u.test(working)) working = `${working}.`
  return working
}

function itemClauses(item: ActionItem): string[] {
  const body = stripFillerText(item.body, item.title)
  const raw = body.length > 0 ? splitSentences(body) : []
  const clauses = (raw.length > 0 ? raw : body.length > 0 ? [body] : []).map((clause) => tidyClause(clause))
  return clauses.filter((clause) => clause.length > 8 && !isFillerSentence(clause))
}

function clusterPreserveTokens(items: readonly ActionItem[]): string[] {
  return uniquePreserve([
    ...items.flatMap((item) => extractProperNames(itemText(item))),
    ...items.flatMap((item) => extractNumbers(itemText(item))),
    ...items.flatMap((item) => extractDeadlines(itemText(item)))
  ])
}

function tokenCovered(token: string, haystack: string): boolean {
  if (extractNumbers(token).length > 0) {
    const hay = canonicalizePhrase(haystack).toLowerCase()
    return hay.includes(token.toLowerCase()) || hay.includes(token.replace(/,/gu, '').toLowerCase())
  }
  if (extractDeadlines(token).length > 0) {
    return canonicalizePhrase(haystack).toLowerCase().includes(token.toLowerCase())
  }
  return namePresentIn(token, factsOf(haystack).names, haystack)
}

function distinctivePhrases(items: readonly ActionItem[], title: string): string[] {
  const titleHay = canonicalizePhrase(title).toLowerCase()
  const phrases: string[] = []
  for (const item of items) {
    const words = canonicalizePhrase(`${item.title} ${item.body}`)
      .toLowerCase()
      .match(/[a-z0-9']+/gu) ?? []
    for (let index = 0; index < words.length - 1; index += 1) {
      const left = words[index] ?? ''
      const right = words[index + 1] ?? ''
      if (CLUSTER_STOP.has(left) || CLUSTER_STOP.has(right)) continue
      const phrase = `${left} ${right}`
      if (phrase.length < 8 || titleHay.includes(phrase)) continue
      phrases.push(phrase)
    }
  }
  return uniquePreserve(phrases)
}

function clauseScore(clause: string, needed: readonly string[], phrases: readonly string[]): number {
  const hits = needed.filter((token) => tokenCovered(token, clause)).length
  const phraseHits = phrases.filter((phrase) => clause.toLowerCase().includes(phrase)).length
  return hits * 100 + phraseHits * 20 - clause.length
}

export function pickClusterBody(
  items: readonly ActionItem[],
  title: string,
  elsewhere: string = ''
): string {
  const haystack = `${title}\n${elsewhere}`
  const needed = clusterPreserveTokens(items).filter((token) => !tokenCovered(token, haystack))
  const phrases = distinctivePhrases(items, title).filter((phrase) => !haystack.toLowerCase().includes(phrase))
  if (needed.length === 0 && phrases.length === 0) return ''

  const clauses = uniquePreserve(items.flatMap((item) => itemClauses(item)))
  if (clauses.length === 0) return ''

  const picked: string[] = []
  let remainingNeeded = [...needed]
  let remainingPhrases = [...phrases]
  while (picked.length < 2 && (remainingNeeded.length > 0 || remainingPhrases.length > 0)) {
    let best: string | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const clause of clauses) {
      if (picked.includes(clause)) continue
      const score = clauseScore(clause, remainingNeeded, remainingPhrases)
      if (score > bestScore) {
        bestScore = score
        best = clause
      }
    }
    if (!best || bestScore <= -best.length) break
    picked.push(best)
    remainingNeeded = remainingNeeded.filter((token) => !tokenCovered(token, best!))
    remainingPhrases = remainingPhrases.filter((phrase) => !best!.toLowerCase().includes(phrase))
  }
  return dedupeClauses(
    picked
      .map((clause) => clause.replace(/[.!?]+$/u, '').trim())
      .filter((clause) => clause.length > 0)
  ).join('; ')
}

export function mergeWorkstreamCluster(items: readonly ActionItem[], elsewhere: string = ''): ActionItem {
  const title = pickDeliverableTitle(items)
  return {
    title,
    owners: uniquePreserve(items.flatMap((item) => impliedSplitOwners(item))),
    body: pickClusterBody(items, title, elsewhere)
  }
}

function ownersOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((owner) => right.some((other) => other.toLowerCase() === owner.toLowerCase()))
}

export function shouldSubsplitCluster(items: readonly ActionItem[]): boolean {
  const seeded = items.map((item) => ({
    owners: impliedSplitOwners(item),
    cls: itemVerbClass(item)
  }))
  const classedOwned = seeded.filter((row) => row.owners.length > 0 && row.cls !== null)
  for (let left = 0; left < classedOwned.length; left += 1) {
    for (let right = left + 1; right < classedOwned.length; right += 1) {
      const a = classedOwned[left]!
      const b = classedOwned[right]!
      if (!ownersOverlap(a.owners, b.owners) && a.cls !== b.cls) return true
    }
  }
  return false
}

function groupLemmaUnion(items: readonly ActionItem[]): Set<string> {
  const lemmas = new Set<string>()
  for (const item of items) {
    for (const lemma of itemLemmaSet(item)) lemmas.add(lemma)
  }
  return lemmas
}

export function subsplitClusterItems(items: readonly ActionItem[]): ActionItem[][] {
  if (items.length < 2 || !shouldSubsplitCluster(items)) return [ [...items] ]

  const groups: { key: string; cls: ActionVerbClass; items: ActionItem[] }[] = []
  const unassigned: ActionItem[] = []
  for (const item of items) {
    const owners = impliedSplitOwners(item)
    const cls = itemVerbClass(item)
    if (owners.length > 0 && cls) {
      const key = `${owners[0]!.toLowerCase()}::${cls}`
      const existing = groups.find((group) => group.key === key)
      if (existing) existing.items.push(item)
      else groups.push({ key, cls, items: [item] })
    } else {
      unassigned.push(item)
    }
  }
  if (groups.length === 0) return [ [...items] ]

  for (const item of unassigned) {
    const cls = itemVerbClass(item)
    const lemmas = itemLemmaSet(item)
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (const [index, group] of groups.entries()) {
      const classBonus = cls && group.cls === cls ? 50 : 0
      const score = classBonus + sharedCount(lemmas, groupLemmaUnion(group.items))
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    groups[bestIndex]?.items.push(item)
  }
  return groups.map((group) => group.items).filter((group) => group.length > 0)
}

export function subsplitClusterIndices(items: readonly ActionItem[], cluster: readonly number[]): number[][] {
  const members = cluster.map((index) => items[index]).filter((item): item is ActionItem => item !== undefined)
  if (members.length !== cluster.length) return [ [...cluster] ]
  const parts = subsplitClusterItems(members)
  return parts.map((part) =>
    part
      .map((item) => items.indexOf(item))
      .filter((index) => index >= 0)
  )
}

function clusterIndices(count: number, related: (left: number, right: number) => boolean): number[][] {
  const parent = Array.from({ length: count }, (_, index) => index)
  const find = (index: number): number => {
    let cursor = index
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor] ?? cursor] ?? cursor
      cursor = parent[cursor] ?? cursor
    }
    return cursor
  }
  const union = (left: number, right: number): void => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft
  }
  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      if (related(left, right)) union(left, right)
    }
  }
  const buckets = new Map<number, number[]>()
  for (let index = 0; index < count; index += 1) {
    const root = find(index)
    const bucket = buckets.get(root)
    if (bucket) bucket.push(index)
    else buckets.set(root, [index])
  }
  return [...buckets.values()]
}

export function nsDuplicatesDecision(ns: ActionItem, decision: ActionItem): boolean {
  if (normalizeTitle(ns.title) === normalizeTitle(decision.title) && normalizeTitle(ns.title).length > 0) {
    return true
  }
  const titleScore = jaccard(contentTokenSet(ns.title), contentTokenSet(decision.title))
  if (titleScore >= NS_DECISION_JACCARD) return true
  return jaccard(contentTokenSet(itemText(ns)), contentTokenSet(itemText(decision))) >= NS_DECISION_JACCARD
}

function nsHasUniqueOwner(ns: ActionItem, decision: ActionItem): boolean {
  const decisionOwners = new Set(decision.owners.map((owner) => owner.toLowerCase()))
  return ns.owners.some((owner) => !decisionOwners.has(owner.toLowerCase()))
}

export function passNsVsDecisions(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const dropNs = new Set<number>()
  const dropDecisions = new Set<number>()

  for (const [nsIndex, ns] of next.nextSteps.entries()) {
    if (dropNs.has(nsIndex)) continue
    for (const [decisionIndex, decision] of next.decisions.entries()) {
      if (dropDecisions.has(decisionIndex)) continue
      if (!nsDuplicatesDecision(ns, decision)) continue
      const beforeNs = renderActionBullet(ns)
      const beforeDecision = renderActionBullet(decision)
      if (nsHasUniqueOwner(ns, decision)) {
        const merged = mergeActionItems([ns, decision])
        next.nextSteps[nsIndex] = merged
        dropDecisions.add(decisionIndex)
        changes.push({
          pass: 'ns-vs-decisions',
          action: 'keep-ns-drop-decision',
          before: `${beforeNs}\n${beforeDecision}`,
          after: renderActionBullet(merged)
        })
      } else {
        const merged = mergeActionItems([decision, ns])
        next.decisions[decisionIndex] = merged
        dropNs.add(nsIndex)
        changes.push({
          pass: 'ns-vs-decisions',
          action: 'keep-decision-drop-ns',
          before: `${beforeDecision}\n${beforeNs}`,
          after: renderActionBullet(merged)
        })
      }
      break
    }
  }

  next.nextSteps = next.nextSteps.filter((_, index) => !dropNs.has(index))
  next.decisions = next.decisions.filter((_, index) => !dropDecisions.has(index))
  return { doc: next, changes }
}

function mergeClusters(
  items: readonly ActionItem[],
  clusters: readonly number[][],
  pass: PassName,
  action: string,
  elsewhereFor: (cluster: readonly number[]) => string
): { items: ActionItem[]; changes: PassChange[] } {
  const mergedItems: ActionItem[] = []
  const changes: PassChange[] = []
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      const only = items[cluster[0]!]
      if (only) mergedItems.push(only)
      continue
    }
    const members = cluster.map((index) => items[index]!).filter(Boolean)
    const merged = mergeWorkstreamCluster(members, elsewhereFor(cluster))
    mergedItems.push(merged)
    changes.push({
      pass,
      action,
      before: members.map((item) => renderActionBullet(item)).join('\n'),
      after: renderActionBullet(merged)
    })
  }
  return { items: mergedItems, changes }
}

export function deterministicNsClusters(items: readonly ActionItem[]): number[][] {
  return clusterIndices(items.length, (left, right) => relatedNextSteps(items[left]!, items[right]!))
}

function haystackExcluding(
  doc: ParsedNotes,
  excludeNs: ReadonlySet<number>,
  excludeDecisions: ReadonlySet<number>
): string {
  const parts: string[] = [doc.prefix]
  for (const section of doc.topical) {
    parts.push(section.name, renderBulletGroups(section.groups))
  }
  for (const [index, item] of doc.decisions.entries()) {
    if (!excludeDecisions.has(index)) parts.push(itemText(item))
  }
  for (const [index, item] of doc.nextSteps.entries()) {
    if (!excludeNs.has(index)) parts.push(itemText(item))
  }
  return parts.join('\n')
}

export function passClusterNs(
  doc: ParsedNotes,
  options: { nsIndexGroups?: number[][]; nsGroupingPath?: 'deterministic' | 'model' } = {}
): { doc: ParsedNotes; changes: PassChange[]; nsGroupingPath: 'deterministic' | 'model' } {
  const next = cloneDoc(doc)
  const rawNs = options.nsIndexGroups ?? deterministicNsClusters(next.nextSteps)
  const nsClusters = rawNs.flatMap((cluster) => subsplitClusterIndices(next.nextSteps, cluster))
  const nsMerged = mergeClusters(next.nextSteps, nsClusters, 'within-ns-cluster', 'merge-ns-cluster', (cluster) =>
    haystackExcluding(next, new Set(cluster), new Set())
  )
  next.nextSteps = nsMerged.items
  const decisionClusters = clusterIndices(next.decisions.length, (left, right) =>
    relatedNearDuplicate(next.decisions[left]!, next.decisions[right]!)
  )
  const decisionMerged = mergeClusters(
    next.decisions,
    decisionClusters,
    'within-ns-cluster',
    'merge-decision-cluster',
    (cluster) => haystackExcluding(next, new Set(), new Set(cluster))
  )
  next.decisions = decisionMerged.items
  return {
    doc: next,
    changes: [...nsMerged.changes, ...decisionMerged.changes],
    nsGroupingPath: options.nsGroupingPath ?? 'deterministic'
  }
}

function stripItemFiller(item: ActionItem): ActionItem {
  return {
    title: item.title.trim(),
    owners: [...item.owners],
    body: stripFillerText(item.body, item.title)
  }
}

function stripGroupFiller(group: BulletGroup): BulletGroup {
  const title = stripFillerText(group.title, null)
  const children = group.children
    .map((child) => stripFillerText(child, group.title))
    .filter((child) => child.length > 0)
  return { title: title.length > 0 ? title : group.title, children }
}

export function passFillerStrip(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []

  const stripList = (items: ActionItem[], label: string): ActionItem[] =>
    items.map((item) => {
      const stripped = stripItemFiller(item)
      if (stripped.body !== item.body) {
        changes.push({
          pass: 'filler-strip',
          action: `strip-${label}`,
          before: renderActionBullet(item),
          after: renderActionBullet(stripped)
        })
      }
      return stripped
    })

  next.decisions = stripList(next.decisions, 'decision')
  next.nextSteps = stripList(next.nextSteps, 'ns')
  next.topical = next.topical.map((section) => ({
    name: section.name,
    groups: section.groups.map((group) => {
      const stripped = stripGroupFiller(group)
      if (groupText(stripped) !== groupText(group)) {
        changes.push({
          pass: 'filler-strip',
          action: `strip-group:${section.name}`,
          before: groupText(group),
          after: groupText(stripped)
        })
      }
      return stripped
    })
  }))
  return { doc: next, changes }
}

function ownersPresent(items: readonly ActionItem[]): Set<string> {
  return new Set(extractOwnerAttributions(items).map((owner) => owner.toLowerCase()))
}

function attachOwners(target: ActionItem, owners: readonly string[]): ActionItem {
  return { ...target, owners: unionOwners(target.owners, owners) }
}

function bestOwnerHome(item: ActionItem, pool: readonly ActionItem[]): number {
  const tokens = contentTokenSet(itemText(item))
  let best = 0
  let bestScore = -1
  for (const [index, candidate] of pool.entries()) {
    const score = jaccard(tokens, contentTokenSet(itemText(candidate)))
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

function preserveUniqueOwners(item: ActionItem, doc: ParsedNotes): void {
  const pool = [...doc.decisions, ...doc.nextSteps]
  const present = ownersPresent(pool)
  const unique = item.owners.filter((owner) => !present.has(owner.toLowerCase()))
  if (unique.length === 0 || pool.length === 0) return
  const index = bestOwnerHome(item, pool)
  if (index < doc.decisions.length) {
    const current = doc.decisions[index]
    if (current) doc.decisions[index] = attachOwners(current, unique)
    return
  }
  const nsIndex = index - doc.decisions.length
  const current = doc.nextSteps[nsIndex]
  if (current) doc.nextSteps[nsIndex] = attachOwners(current, unique)
}

export function isPastTenseCompleted(item: ActionItem): boolean {
  const text = itemText(item)
  if (!PAST_COMPLETION.some((pattern) => pattern.test(text))) return false
  if (FORWARD_LOOKING.test(text)) return false
  return true
}

function topicalMarkdown(doc: ParsedNotes): string {
  return doc.topical
    .map((section) => `## ${section.name}\n${renderBulletGroups(section.groups)}`)
    .join('\n')
}

function alreadyInBody(item: ActionItem, doc: ParsedNotes): boolean {
  const cleaned = { ...item, body: item.body.replace(RATIONALE_PREFIX, '').trim() }
  const itemTokens = contentTokenSet(itemText(cleaned))
  const bodyTokens = contentTokenSet(cleaned.body)
  if (itemTokens.size === 0) return false
  for (const section of doc.topical) {
    for (const group of section.groups) {
      const groupTokens = contentTokenSet(groupText(group))
      if (containment(itemTokens, groupTokens) >= BODY_ALREADY_PRESENT_RATIO) return true
      if (bodyTokens.size >= 4 && containment(bodyTokens, groupTokens) >= BODY_ALREADY_PRESENT_RATIO) return true
    }
  }
  const topicalTokens = contentTokenSet(topicalMarkdown(doc))
  return (
    containment(itemTokens, topicalTokens) >= BODY_ALREADY_PRESENT_RATIO ||
    (bodyTokens.size >= 4 && containment(bodyTokens, topicalTokens) >= BODY_ALREADY_PRESENT_RATIO)
  )
}

function bestSectionIndex(item: ActionItem, doc: ParsedNotes): number {
  const itemTokens = contentTokenSet(itemText(item))
  let best = 0
  let bestScore = -1
  for (const [index, section] of doc.topical.entries()) {
    const score = jaccard(itemTokens, contentTokenSet(renderBulletGroups(section.groups) + ' ' + section.name))
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

export function passPastTenseDemote(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const kept: ActionItem[] = []
  const demote: ActionItem[] = []
  for (const item of next.nextSteps) {
    if (isPastTenseCompleted(item)) demote.push(item)
    else kept.push(item)
  }
  next.nextSteps = kept
  for (const item of demote) {
    const before = renderActionBullet(item)
    preserveUniqueOwners(item, next)
    if (alreadyInBody(item, next)) {
      changes.push({
        pass: 'past-tense-demotion',
        action: 'drop-completed-ns',
        before,
        after: null
      })
      continue
    }
    const sectionIndex = bestSectionIndex(item, next)
    const section = next.topical[sectionIndex]
    const bullet = item.body.trim().length > 0 ? `${item.title.replace(/\.+$/u, '')}. ${item.body}` : item.title
    if (section) {
      section.groups.push({ title: bullet, children: [] })
      changes.push({
        pass: 'past-tense-demotion',
        action: `relocate-to:${section.name}`,
        before,
        after: `- ${bullet}`
      })
    } else {
      next.nextSteps.push(item)
    }
  }
  return { doc: next, changes }
}

function groupTokenSet(group: BulletGroup): Set<string> {
  return contentTokenSet(groupText(group))
}

export function groupIsSubset(inner: BulletGroup, outer: BulletGroup): boolean {
  if (inner === outer) return false
  const ratio = containment(groupTokenSet(inner), groupTokenSet(outer))
  if (ratio < GROUP_SUBSET_TOKEN_RATIO) return false
  return namesNumbersSubset(groupText(inner), groupText(outer))
}

export function groupsPartialOverlap(left: BulletGroup, right: BulletGroup): boolean {
  const leftTokens = groupTokenSet(left)
  const rightTokens = groupTokenSet(right)
  const leftInRight = containment(leftTokens, rightTokens)
  const rightInLeft = containment(rightTokens, leftTokens)
  const ratio = Math.max(leftInRight, rightInLeft)
  if (ratio >= GROUP_PARTIAL_TOKEN_RATIO) return true
  const leftFacts = extractFacts(groupText(left))
  const sharedNames = leftFacts.names.filter((name) => namePresentIn(name, factsOf(groupText(right)).names, groupText(right)))
  return sharedNames.length >= 1 && ratio >= GROUP_PARTIAL_SHARED_NAME_RATIO
}

/** Magnitude words that are numbers even without digits. */
const QUANTITY_WORD = /\b(?:million|thousand|billion|hundred)\b/giu

function visibleNames(text: string): string[] {
  const names = [...extractProperNames(text)]
  for (const line of text.split(/\r?\n/u)) {
    for (const match of line.matchAll(/\b[A-Z][a-z]{2,}\b/gu)) {
      const token = match[0] ?? ''
      if (token.length > 0 && !isNameStop(token)) names.push(token)
    }
    for (const match of line.matchAll(/\b[A-Z]{2,}\b/gu)) {
      const token = match[0] ?? ''
      if (token.length > 0 && !isNameStop(token)) names.push(token)
    }
  }
  return uniquePreserve(names)
}

function visibleNumbers(text: string): string[] {
  const numbers = [...extractNumbers(text)]
  for (const match of text.matchAll(QUANTITY_WORD)) {
    if (match[0]) numbers.push(match[0].toLowerCase())
  }
  return uniquePreserve(numbers)
}

export function groupFactCount(group: BulletGroup): number {
  const text = groupText(group)
  return visibleNames(text).length + visibleNumbers(text).length
}

function betterTopBullet(left: BulletGroup, right: BulletGroup): BulletGroup {
  const leftFacts = groupFactCount(left)
  const rightFacts = groupFactCount(right)
  if (leftFacts !== rightFacts) return leftFacts >= rightFacts ? left : right
  const leftCount = groupTokenSet(left).size
  const rightCount = groupTokenSet(right).size
  if (leftCount !== rightCount) return leftCount >= rightCount ? left : right
  return groupText(left).length >= groupText(right).length ? left : right
}

function headingLemmaOverlap(sectionName: string, parentTitle: string): number {
  return sharedCount(distinctiveContentLemmas(sectionName), distinctiveContentLemmas(parentTitle))
}

function sectionForParentTitle(doc: ParsedNotes, parentTitle: string, fallbackIndex: number): number {
  let best = fallbackIndex
  let bestScore = headingLemmaOverlap(doc.topical[fallbackIndex]?.name ?? '', parentTitle)
  for (const [index, section] of doc.topical.entries()) {
    const score = headingLemmaOverlap(section.name, parentTitle)
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

function childRedundant(child: string, target: BulletGroup): boolean {
  const tokens = contentTokenSet(child)
  if (tokens.size === 0) return true
  if (containment(tokens, contentTokenSet(target.title)) >= 0.8) return true
  return target.children.some((existing) => {
    const existingTokens = contentTokenSet(existing)
    return containment(tokens, existingTokens) >= 0.75 || jaccard(tokens, existingTokens) >= 0.7
  })
}

function mergeGroups(keep: BulletGroup, drop: BulletGroup): BulletGroup {
  const children = [...keep.children]
  const incoming = [...drop.children]
  if (!childRedundant(drop.title, { title: keep.title, children }) && containment(contentTokenSet(drop.title), groupTokenSet(keep)) < 0.7) {
    incoming.unshift(drop.title)
  }
  for (const child of incoming) {
    if (childRedundant(child, { title: keep.title, children })) continue
    children.push(child)
  }
  return { title: keep.title, children }
}

interface LocatedGroup {
  sectionIndex: number
  groupIndex: number
  group: BulletGroup
  alive: boolean
}

export function passCrossGroupDedup(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const located: LocatedGroup[] = []
  for (const [sectionIndex, section] of next.topical.entries()) {
    for (const [groupIndex, group] of section.groups.entries()) {
      located.push({ sectionIndex, groupIndex, group, alive: true })
    }
  }

  const bySize = [...located.keys()].sort((left, right) => {
    const sizeDelta = groupTokenSet(located[left]!.group).size - groupTokenSet(located[right]!.group).size
    if (sizeDelta !== 0) return sizeDelta
    return left - right
  })

  const pickPartner = (b: LocatedGroup, sameSectionOnly: boolean): { partner: LocatedGroup; subset: boolean } | null => {
    let partner: LocatedGroup | null = null
    let subset = false
    for (const candidate of located) {
      if (!candidate.alive || candidate === b) continue
      if (sameSectionOnly && candidate.sectionIndex !== b.sectionIndex) continue
      if (!sameSectionOnly && candidate.sectionIndex === b.sectionIndex) continue
      if (groupIsSubset(b.group, candidate.group)) {
        partner = candidate
        subset = true
        break
      }
      if (groupsPartialOverlap(b.group, candidate.group)) {
        const bSize = groupTokenSet(b.group).size
        const cSize = groupTokenSet(candidate.group).size
        if (bSize > cSize) continue
        if (!partner) partner = candidate
      }
    }
    return partner ? { partner, subset } : null
  }

  for (const bIndex of bySize) {
    const b = located[bIndex]
    if (!b || !b.alive) continue
    const match = pickPartner(b, true) ?? pickPartner(b, false)
    if (!match) continue
    const partner = match.partner
    if (!partner.alive) continue

    const beforeB = groupText(b.group)
    const beforeA = groupText(partner.group)
    if (match.subset) {
      b.alive = false
      changes.push({
        pass: 'cross-group-body-dedup',
        action: 'delete-subset-group',
        before: beforeB,
        after: beforeA
      })
      continue
    }
    const keepLoc = betterTopBullet(partner.group, b.group) === partner.group ? partner : b
    const dropLoc = keepLoc === partner ? b : partner
    const merged = mergeGroups(keepLoc.group, dropLoc.group)
    keepLoc.group = merged
    dropLoc.alive = false
    if (keepLoc.sectionIndex !== dropLoc.sectionIndex) {
      keepLoc.sectionIndex = sectionForParentTitle(next, merged.title, keepLoc.sectionIndex)
    }
    changes.push({
      pass: 'cross-group-body-dedup',
      action: 'merge-overlap-groups',
      before: `${beforeA}\n---\n${beforeB}`,
      after: groupText(merged)
    })
  }

  next.topical = next.topical.map((section, sectionIndex) => ({
    name: section.name,
    groups: located
      .filter((row) => row.sectionIndex === sectionIndex && row.alive)
      .map((row) => row.group)
  }))
  return { doc: next, changes }
}

const CONTRAST_LEAD = /^(still|but|however|though)\b/iu
const PREDICATE_LEAD_LEMMAS = new Set([
  ...GENERIC_VERBS,
  'deploy',
  'work',
  'requir',
  'monitor',
  'assign',
  'vote',
  'remain',
  'focus',
  'affect',
  'still',
  'has',
  'have'
])
const REPORTING_VERB = 'indicates|states|says|mentions|notes|shows|reports'
const REPORTING_SPLIT = new RegExp(`\\b(?:and\\s+)?(?:${REPORTING_VERB})(?:\\s+that)?\\b`, 'giu')
const DECLARATIVE_VERB =
  /\b(?:is|are|was|were|be|been|being|will|would|can|could|may|might|must|shall|should|has|have|had|does|do|did|need|needs|needed)\b/iu

function listMarker(line: string): string {
  return line.match(/^\s*[-*]\s+/u)?.[0] ?? ''
}

function cleanCatalogFact(text: string): string {
  return stripLegacyish(stripFillerText(text, null)).replace(/\s+/gu, ' ').trim()
}

function stripLegacyish(text: string): string {
  return text.replace(/\s*\[(?:them|me)\]\s*/giu, ' ').replace(/\s+/gu, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function recaseLine(text: string): string {
  if (text.length === 0) return text
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function hasDeclarativeVerb(text: string): boolean {
  return DECLARATIVE_VERB.test(text)
}

function startsWithCapital(text: string): boolean {
  return /^\p{Lu}/u.test(text)
}

function needForDeclarative(clause: string): string {
  const match = clause.match(/^a need for ((?:an? )?\S+)(.*)$/iu)
  if (!match) return recaseLine(clause)
  const noun = match[1] ?? ''
  const rest = match[2] ?? ''
  return `${recaseLine(noun)} is needed${rest}`
}

function subjectHead(clause: string): string | null {
  const match = clause.match(/^(?:an?|the)\s+(\S+)/iu)
  return match?.[1]?.toLowerCase() ?? null
}

function dropRepeatedSubject(clause: string, head: string | null): string {
  if (!head) return clause
  const stripped = clause.replace(new RegExp(`^(?:an?|the)\\s+${escapeRegExp(head)}\\s+`, 'iu'), '')
  return stripped === clause ? clause : stripped
}

function grammaticalIdStrip(line: string): string | null {
  const parts = line
    .replace(new RegExp(CATALOG_ITEM_ID_PATTERN.source, 'gu'), ' ')
    .split(new RegExp(REPORTING_SPLIT.source, 'giu'))
    .map((part) => part.replace(/\s+/gu, ' ').replace(/^[,;:\s]+|[,;:\s]+$/gu, '').trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null
  const declaratives = parts.map((part) => needForDeclarative(part))
  const head = subjectHead(declaratives[0] ?? '')
  const joined = declaratives
    .map((part, index) => (index === 0 ? part : dropRepeatedSubject(part, head)))
    .filter((part) => part.length > 0)
    .join(' and ')
    .replace(/\s+/gu, ' ')
    .trim()
  const withStop = /[.!?]$/u.test(joined) ? joined : `${joined}.`
  if (!startsWithCapital(withStop) || !hasDeclarativeVerb(withStop)) return null
  return withStop
}

export function repairIdLeakLine(line: string, catalog: Readonly<Record<string, string>>): string {
  if (!containsCatalogItemId(line)) return line
  const marker = listMarker(line)
  const ids = [...line.matchAll(new RegExp(CATALOG_ITEM_ID_PATTERN.source, 'gu'))].map((match) => match[0] ?? '')
  const sources = uniquePreserve(ids.map((id) => catalog[id]).filter((text): text is string => Boolean(text)))
  const catalogFact = cleanCatalogFact(sources.join(' '))
  const rebuilt = grammaticalIdStrip(line.replace(/^\s*[-*]\s+/u, ''))
  const fact = rebuilt ?? (catalogFact.length > 0 ? catalogFact : '')
  if (fact.length === 0) return line
  return fact.startsWith('-') || fact.startsWith('*') ? fact : `${marker}${fact}`
}

export function passIdLeakRepair(
  doc: ParsedNotes,
  catalog: Readonly<Record<string, string>> = {}
): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const rewrite = (text: string): string => {
    if (!containsCatalogItemId(text)) return text
    const repaired = repairIdLeakLine(text, catalog)
    if (repaired !== text) {
      changes.push({ pass: 'id-leak-repair', action: 'replace-item-id', before: text, after: repaired })
    }
    return repaired
  }
  next.prefix = rewrite(next.prefix)
  next.topical = next.topical.map((section) => ({
    name: section.name,
    groups: section.groups.map((group) => ({
      title: rewrite(group.title),
      children: group.children.map((child) => rewrite(child))
    }))
  }))
  next.decisions = next.decisions.map((item) => ({
    ...item,
    title: rewrite(item.title),
    body: rewrite(item.body)
  }))
  next.nextSteps = next.nextSteps.map((item) => ({
    ...item,
    title: rewrite(item.title),
    body: rewrite(item.body)
  }))
  return { doc: next, changes }
}

export function passMisfiledChildren(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const headingLemmas = next.topical.map((section) => distinctiveContentLemmas(section.name))
  const kept: BulletGroup[][] = next.topical.map(() => [])
  for (const [sectionIndex, section] of next.topical.entries()) {
    for (const group of section.groups) {
      const titleLemmas = distinctiveContentLemmas(group.title)
      const home = sharedCount(titleLemmas, headingLemmas[sectionIndex] ?? new Set())
      if (home >= 1) {
        kept[sectionIndex]!.push(group)
        continue
      }
      let best = -1
      let bestShared = 0
      for (const [otherIndex] of next.topical.entries()) {
        if (otherIndex === sectionIndex) continue
        const shared = sharedCount(titleLemmas, headingLemmas[otherIndex] ?? new Set())
        if (shared > bestShared) {
          bestShared = shared
          best = otherIndex
        }
      }
      if (best >= 0 && bestShared >= 1) {
        kept[best]!.push(group)
        changes.push({
          pass: 'misfiled-child-repair',
          action: 'move-whole-group',
          before: `${section.name}\n${groupText(group)}`,
          after: next.topical[best]!.name
        })
      } else {
        kept[sectionIndex]!.push(group)
      }
    }
  }
  next.topical = next.topical.map((section, index) => ({ name: section.name, groups: kept[index] ?? [] }))
  return { doc: next, changes }
}

function childHasDistinctFacts(child: string, group: BulletGroup): boolean {
  const groupHay = `${group.title}\n${group.children.filter((row) => row !== child).join('\n')}`
  const names = extractProperNames(child)
  const numbers = extractNumbers(child)
  const owners = extractOwnerAttributions([parseActionBullet(`* **${child}**`)])
  for (const name of names) {
    if (!namePresentIn(name, factsOf(groupHay).names, groupHay)) return true
  }
  for (const number of numbers) {
    if (!groupHay.toLowerCase().includes(number.toLowerCase())) return true
  }
  for (const owner of owners) {
    if (!groupHay.toLowerCase().includes(owner.toLowerCase())) return true
  }
  return false
}

function decapitalize(text: string): string {
  if (text.length === 0) return text
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`
}

function firstWord(text: string): string {
  return text.match(/^\S+/u)?.[0] ?? ''
}

function isAcronymToken(token: string): boolean {
  return /^[A-Z]{2,}/u.test(token)
}

function isInflectedVerbToken(token: string): boolean {
  return token.length > 4 && /(?:ed|ing|es|s)$/u.test(token)
}

const EVALUATIVE_LEAD = new Set([
  'easy',
  'hard',
  'possibl',
  'recent',
  'current',
  'expect',
  'immediat',
  'prolong',
  'signific',
  'better',
  'wors',
  'will'
])

function nameMatchesToken(name: string, word: string): boolean {
  const lower = word.toLowerCase()
  return name.toLowerCase() === lower || name.split(/\s+/u)[0]?.toLowerCase() === lower
}

/** True when the fragment's first token is a proper name or acronym and must keep its capital. */
function firstTokenIsProperName(text: string, context: string = text): boolean {
  const raw = firstWord(text)
  const word = raw.replace(/[^A-Za-z]/gu, '')
  if (word.length === 0) return false
  if (isAcronymToken(raw)) return true
  const lemma = lightStem(word.toLowerCase())
  if (
    GENERIC_VERBS.has(lemma) ||
    PREDICATE_LEAD_LEMMAS.has(lemma) ||
    EVALUATIVE_LEAD.has(lemma) ||
    isNameStop(word) ||
    isInflectedVerbToken(word)
  ) {
    return false
  }
  const names = [...extractProperNames(context), ...extractProperNames(`already ${text}`)]
  return names.some((name) => nameMatchesToken(name, word))
}

function decapitalizeUnlessName(text: string, context: string = text): string {
  if (firstTokenIsProperName(text, context)) return text
  return decapitalize(text)
}

function tokensOf(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token.length > 0)
}

/** Longest shared leading token run; elide when it is a phrase (≥2 tokens). */
const LEADING_PREDICATE_MIN = 2

function commonLeadingTokenCount(left: string, right: string): number {
  const leftTokens = tokensOf(left)
  const rightTokens = tokensOf(right)
  let count = 0
  while (
    count < leftTokens.length &&
    count < rightTokens.length &&
    leftTokens[count]!.toLowerCase() === rightTokens[count]!.toLowerCase()
  ) {
    count += 1
  }
  return count
}

function elideLeadingPredicate(first: string, next: string): string {
  const shared = commonLeadingTokenCount(first, next)
  if (shared < LEADING_PREDICATE_MIN) return next
  return tokensOf(next).slice(shared).join(' ')
}

export function joinFragmentRun(parts: readonly string[]): string {
  const cleaned = parts.map((part) => part.replace(/[.!?]+$/u, '').trim()).filter(Boolean)
  if (cleaned.length === 0) return ''
  if (cleaned.length === 1) return cleaned[0]!
  const first = cleaned[0]!
  let out = first
  for (let index = 1; index < cleaned.length; index += 1) {
    const raw = cleaned[index]!
    const contrast = CONTRAST_LEAD.test(raw)
    const rest = raw.replace(CONTRAST_LEAD, '').trim()
    const elided = elideLeadingPredicate(first, rest.length > 0 ? rest : raw)
    const piece = decapitalizeUnlessName(elided, cleaned.join(' '))
    if (piece.length === 0) continue
    out += contrast ? `, but ${piece}` : index === cleaned.length - 1 ? ` and ${piece}` : `, ${piece}`
  }
  return out
}

export function passFragmentFusion(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  next.topical = next.topical.map((section) => ({
    name: section.name,
    groups: section.groups.map((group) => {
      const children: string[] = []
      let run: string[] = []
      const flush = (): void => {
        if (run.length === 0) return
        if (run.length === 1) children.push(run[0]!)
        else {
          const joined = joinFragmentRun(run)
          changes.push({
            pass: 'fragment-fusion',
            action: 'join-fragments',
            before: run.join('\n'),
            after: joined
          })
          children.push(joined)
        }
        run = []
      }
      for (const child of group.children) {
        if (!childHasDistinctFacts(child, group)) run.push(child)
        else {
          flush()
          children.push(child)
        }
      }
      flush()
      return { title: group.title, children }
    })
  }))
  return { doc: next, changes }
}

function groupHasAnyFact(group: BulletGroup): boolean {
  const text = groupText(group)
  if (extractNumbers(text).length > 0) return true
  if (extractProperNames(text).length > 0) return true
  for (const line of [group.title, ...group.children]) {
    const tokens = [...line.matchAll(/\b[A-Z][A-Za-z]{2,}\b/gu)].map((match) => match[0] ?? '')
    for (const [index, token] of tokens.entries()) {
      if (index === 0) continue
      const lemma = lightStem(token.toLowerCase())
      if (GENERIC_VERBS.has(lemma) || PREDICATE_LEAD_LEMMAS.has(lemma) || CLUSTER_STOP.has(token.toLowerCase())) {
        continue
      }
      return true
    }
  }
  return false
}

/** Title words that mark a group as motivation/rationale rather than a discussion point. */
const MOTIVATION_TITLE = /\b(impact|rationale|motivation|reason|why|benefit)s?\b/iu

export function passMotivationDrop(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  next.topical = next.topical.map((section, sectionIndex) => {
    const kept: BulletGroup[] = []
    for (const [index, group] of section.groups.entries()) {
      if (groupHasAnyFact(group) || !MOTIVATION_TITLE.test(group.title)) {
        kept.push(group)
        continue
      }
      const elsewhere = [
        ...next.topical.flatMap((other, otherIndex) =>
          other.groups
            .filter((_, groupIndex) => otherIndex !== sectionIndex || groupIndex !== index)
            .map((row) => groupText(row))
        ),
        ...next.decisions.map((item) => itemText(item)),
        ...next.nextSteps.map((item) => itemText(item))
      ].join('\n')
      const lemmas = contentLemmaSet(groupText(group))
      const covered = containment(lemmas, contentLemmaSet(elsewhere))
      if (lemmas.size > 0 && covered >= BODY_ALREADY_PRESENT_RATIO) {
        changes.push({
          pass: 'motivation-drop',
          action: 'drop-covered-motivation',
          before: groupText(group),
          after: null
        })
        continue
      }
      kept.push(group)
    }
    return { name: section.name, groups: kept }
  })
  return { doc: next, changes }
}

function passDedupeActionBodies(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  const rewrite = (item: ActionItem, label: string): ActionItem => {
    const clauses = item.body.split(/\s*;\s*/u).map((row) => row.trim()).filter(Boolean)
    if (clauses.length < 2) return item
    const deduped = dedupeClauses(clauses)
    if (deduped.length === clauses.length && deduped.every((row, index) => row === clauses[index])) return item
    const body = deduped.join('; ')
    changes.push({
      pass: 'within-ns-cluster',
      action: `dedupe-${label}-clauses`,
      before: item.body,
      after: body
    })
    return { ...item, body }
  }
  next.decisions = next.decisions.map((item) => rewrite(item, 'decision'))
  next.nextSteps = next.nextSteps.map((item) => rewrite(item, 'ns'))
  return { doc: next, changes }
}

function siblingSpecificity(line: string): number {
  return visibleNames(line).length + visibleNumbers(line).length
}

function siblingNearSubset(inner: string, outer: string): boolean {
  return clauseNearSubset(inner, outer, PREDICATE_LEAD_LEMMAS)
}

export function dedupeSiblingChildren(children: readonly string[]): string[] {
  const kept: string[] = []
  for (const child of children) {
    const trimmed = child.trim()
    if (trimmed.length === 0) continue
    const subsetOf = kept.findIndex((existing) => siblingNearSubset(trimmed, existing))
    if (subsetOf >= 0) continue
    const covered = kept
      .map((existing, index) => (siblingNearSubset(existing, trimmed) ? index : -1))
      .filter((index) => index >= 0)
    if (covered.length > 0) {
      const best = covered.reduce((winner, index) =>
        siblingSpecificity(kept[index]!) >= siblingSpecificity(kept[winner]!) ? index : winner
      )
      if (siblingSpecificity(trimmed) > siblingSpecificity(kept[best]!)) {
        kept[best] = trimmed
        for (const index of covered.filter((row) => row !== best).sort((left, right) => right - left)) {
          kept.splice(index, 1)
        }
      }
      continue
    }
    kept.push(trimmed)
  }
  return kept
}

export function cleanDecisionTitle(title: string): string {
  const cleaned = title
    .replace(DECISION_TITLE_NOISE, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/gu, '')
    .trim()
  if (cleaned.length === 0) return title.trim()
  const leadingName = extractProperNames(cleaned)[0]
  if (leadingName && cleaned.startsWith(leadingName)) return cleaned
  if (/^[A-Z][a-z]/.test(cleaned)) return `${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`
  return cleaned
}

function firstSentence(text: string): string {
  const trimmed = text.trim()
  const stop = trimmed.search(/[.!](?:\s|$)/u)
  const clause = (stop >= 0 ? trimmed.slice(0, stop) : trimmed).replace(/;.*$/u, '').trim()
  return clause.replace(/[,.\s]+$/u, '').trim()
}

export function agreedDecisionLine(item: ActionItem): string {
  const body = item.body.replace(/^\s*rationale:\s*/iu, '').trim()
  const match = CLOSED_CHOICE_COMPLEMENT.exec(body)
  const clause = match?.[1] ? firstSentence(match[1]) : cleanDecisionTitle(item.title)
  const sentence = clause.length > 0 ? clause : cleanDecisionTitle(item.title)
  return `Agreed: ${sentence}`
}

/** Framing from "the team agreed/decided" must not pull later lines onto an existing Agreed child. */
const PLACEMENT_FRAME_LEMMAS = new Set(['agree', 'decid', 'decision'])

function placementLemmas(text: string): Set<string> {
  const lemmas = distinctiveContentLemmas(text)
  for (const frame of PLACEMENT_FRAME_LEMMAS) lemmas.delete(frame)
  return lemmas
}

function distinctiveOverlap(left: string, right: string): number {
  return sharedCount(placementLemmas(left), placementLemmas(right))
}

function groupTextForPlacement(group: BulletGroup): string {
  return [group.title, ...group.children.filter((child) => !/^agreed:/iu.test(child.trim()))]
    .filter((row) => row.trim().length > 0)
    .join('\n')
}

function sectionCorpus(section: TopicalSection): string {
  return [section.name, ...section.groups.map((group) => groupTextForPlacement(group))].join('\n')
}

function pickAgreedSection(doc: ParsedNotes, probe: string): number {
  if (doc.topical.length === 0) return -1
  let bestShared = 0
  const tied: number[] = []
  for (const [index, section] of doc.topical.entries()) {
    const shared = distinctiveOverlap(probe, sectionCorpus(section))
    if (shared > bestShared) {
      bestShared = shared
      tied.length = 0
      tied.push(index)
    } else if (shared === bestShared && shared > 0) {
      tied.push(index)
    }
  }
  if (bestShared >= 1 && tied.length === 1) return tied[0]!
  if (bestShared >= 1 && tied.length > 1) {
    let headingBest = tied[0]!
    let headingShared = -1
    for (const index of tied) {
      const shared = distinctiveOverlap(probe, doc.topical[index]!.name)
      if (shared > headingShared) {
        headingShared = shared
        headingBest = index
      }
    }
    return headingBest
  }
  let headingBest = -1
  let headingShared = 0
  for (const [index, section] of doc.topical.entries()) {
    const shared = distinctiveOverlap(probe, section.name)
    if (shared > headingShared) {
      headingShared = shared
      headingBest = index
    }
  }
  if (headingShared >= 1) return headingBest
  return doc.topical.length - 1
}

function placeAgreedLine(doc: ParsedNotes, line: string, source: ActionItem): { section: string; how: string } {
  const probe = `${source.title} ${source.body}`
  const sectionIndex = pickAgreedSection(doc, probe)
  if (sectionIndex < 0) {
    doc.topical.push({ name: 'Notes', groups: [{ title: line, children: [] }] })
    return { section: 'Notes', how: 'new-section' }
  }
  const section = doc.topical[sectionIndex]!
  let bestGroup = -1
  let bestShared = 0
  for (const [groupIndex, group] of section.groups.entries()) {
    const shared = distinctiveOverlap(probe, groupTextForPlacement(group))
    if (shared > bestShared) {
      bestShared = shared
      bestGroup = groupIndex
    }
  }
  if (bestShared >= 1 && bestGroup >= 0) {
    const group = section.groups[bestGroup]!
    if (!group.children.some((child) => child.toLowerCase() === line.toLowerCase())) {
      group.children.push(line)
    }
    return { section: section.name, how: 'child' }
  }
  section.groups.push({ title: line, children: [] })
  return { section: section.name, how: 'new-group' }
}

export function isClosedDecision(item: ActionItem): boolean {
  if (item.owners.length > 0) return false
  if (OPEN_WORK_TITLE.test(item.title.trim())) return false
  const cleaned = cleanDecisionTitle(item.title)
  if (IMPERATIVE_OPEN_TITLE.test(item.title.trim()) || IMPERATIVE_OPEN_TITLE.test(cleaned)) return false
  const text = itemText(item)
  if (FUTURE_OBLIGATION.test(text)) return false
  if (TO_UNFINISHED_WORK.test(text)) return false
  return true
}

function leftoverNumberTokens(body: string): string[] {
  const digits = extractNumbers(body).map((num) => {
    const escaped = num.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const withUnit = new RegExp(`${escaped}(/[A-Za-z]+)`, 'u').exec(body)
    return withUnit ? `${num}${withUnit[1]}` : num
  })
  const quantities = [...body.matchAll(QUANTITY_WORD)].map((match) => (match[0] ?? '').toLowerCase())
  return uniquePreserve([...digits, ...quantities])
}

function leftoverTokenPresent(token: string, haystack: string, kind: 'name' | 'number' | 'other'): boolean {
  if (haystack.toLowerCase().includes(token.toLowerCase())) return true
  if (kind === 'number') {
    const compact = token.toLowerCase().replace(/\s+/gu, '')
    return factsOf(haystack).numbers.has(compact) || factsOf(haystack).numbers.has(token.toLowerCase())
  }
  if (kind === 'name') return namePresentIn(token, factsOf(haystack).names, haystack)
  return false
}

function isLeftoverVerb(token: string): boolean {
  const lower = token.toLowerCase()
  const stem = lightStem(lower)
  if (GENERIC_VERBS.has(lower) || GENERIC_VERBS.has(stem)) return true
  if (LEFTOVER_EXTRA_VERB.test(stem) || LEFTOVER_EXTRA_VERB.test(lower)) return true
  for (const verb of GENERIC_VERBS) {
    if (verb.length >= 4 && stem.startsWith(verb)) return true
  }
  return false
}

const LEFTOVER_DISCOURSE = new Set([
  'otherwise',
  'however',
  'therefore',
  'meanwhile',
  'regardless',
  'instead',
  'moreover'
])

export function isAllowedLeftoverName(name: string): boolean {
  const tokens = name.split(/\s+/u).filter((token) => token.length > 0 && !isNameStop(token))
  if (tokens.length === 0) return false
  if (tokens.some((token) => isLeftoverVerb(token))) return false
  if (tokens.some((token) => LEFTOVER_COMMON_NOUN.has(token.toLowerCase()))) return false
  if (tokens.some((token) => LEFTOVER_DISCOURSE.has(token.toLowerCase()))) return false
  return true
}

/** Drop "Century" when the only hit was the rejected span "Century Log". */
export function leftoverGuardNames(names: readonly string[]): string[] {
  const allowed = names.filter((name) => isAllowedLeftoverName(name))
  const rejected = names.filter((name) => !isAllowedLeftoverName(name))
  return allowed.filter(
    (name) =>
      !rejected.some((span) => span.toLowerCase().includes(name.toLowerCase()) && span.length > name.length)
  )
}

/** Title-Case names from the body; sentence-initial verbs are still extracted then filtered. */
function namesFromFooterBody(body: string): string[] {
  const continued = `noted ${body.replace(/([.!?]\s+)/gu, '$1noted ')}`
  const raw = extractProperNames(continued)
  const allowed = raw.filter((name) => isAllowedLeftoverName(name))
  const rejected = raw.filter((name) => !isAllowedLeftoverName(name))
  return allowed.filter(
    (name) =>
      !rejected.some(
        (span) => span.toLowerCase().includes(name.toLowerCase()) && span.length > name.length
      )
  )
}

export function leftoverFooterFacts(item: ActionItem, elsewhere: string): string[] {
  const body = item.body.trim()
  if (body.length === 0) return []
  const known = `${item.title} ${item.owners.join(' ')}\n${elsewhere}`
  const found: { index: number; token: string }[] = []
  const consider = (token: string, kind: 'name' | 'number' | 'other'): void => {
    const trimmed = token.trim()
    if (trimmed.length === 0) return
    if (item.owners.some((owner) => owner.toLowerCase() === trimmed.toLowerCase())) return
    if (leftoverTokenPresent(trimmed, known, kind)) return
    const index = body.toLowerCase().indexOf(trimmed.toLowerCase())
    found.push({ index: index < 0 ? body.length : index, token: trimmed })
  }
  for (const name of namesFromFooterBody(body)) consider(name, 'name')
  for (const product of body.match(new RegExp(CAMEL_PRODUCT.source, 'gu')) ?? []) consider(product, 'other')
  for (const id of body.match(new RegExp(ALNUM_IDENTIFIER.source, 'gu')) ?? []) consider(id, 'other')
  for (const num of leftoverNumberTokens(body)) consider(num, 'number')
  for (const deadline of body.match(new RegExp(LEFTOVER_DEADLINE.source, 'giu')) ?? []) {
    consider(deadline, 'other')
  }
  found.sort((left, right) => left.index - right.index)
  const unique = uniquePreserve(found.map((row) => row.token))
  return unique.filter(
    (token, index) =>
      !unique.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.toLowerCase().includes(token.toLowerCase()) &&
          other.length > token.length
      )
  )
}

function topicalElsewhere(doc: ParsedNotes): string {
  return [
    doc.prefix,
    ...doc.topical.map((section) => `${section.name}\n${renderBulletGroups(section.groups)}`)
  ].join('\n')
}

function compactFooterItem(item: ActionItem, elsewhere: string): ActionItem {
  const leftover = leftoverFooterFacts(item, elsewhere)
  return {
    title: item.title,
    owners: uniquePreserve([...item.owners, ...leftover]),
    body: ''
  }
}

export function passFooterPresentation(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []

  const stay: ActionItem[] = []
  const moved: ActionItem[] = []
  for (const decision of next.decisions) {
    if (isClosedDecision(decision)) {
      stay.push(decision)
      continue
    }
    const match = next.nextSteps.findIndex((ns) => nsDuplicatesDecision(ns, decision))
    const before = renderActionBullet(decision)
    if (match >= 0) {
      const ns = next.nextSteps[match]!
      const merged: ActionItem = {
        ...ns,
        owners: uniquePreserve([...ns.owners, ...decision.owners])
      }
      next.nextSteps[match] = merged
      changes.push({
        pass: 'footer-presentation',
        action: 'drop-decision-keep-ns',
        before: `${before}\n${renderActionBullet(ns)}`,
        after: renderActionBullet(merged)
      })
    } else {
      moved.push(decision)
      changes.push({
        pass: 'footer-presentation',
        action: 'reclassify-decision-to-ns',
        before,
        after: renderActionBullet(decision)
      })
    }
  }
  next.decisions = stay
  next.nextSteps = [...next.nextSteps, ...moved]

  for (const decision of next.decisions) {
    const line = agreedDecisionLine(decision)
    const placed = placeAgreedLine(next, line, decision)
    changes.push({
      pass: 'footer-presentation',
      action: 'inline-decision-agreed',
      before: renderActionBullet(decision),
      after: `${placed.section} (${placed.how}): ${line}`
    })
  }
  next.decisions = []
  next.hasDecisionsHeading = false

  let elsewhere = [
    topicalElsewhere(next),
    ...next.nextSteps.map((item) => item.title)
  ].join('\n')

  const compactList = (items: ActionItem[], label: string): ActionItem[] =>
    items.map((item) => {
      const before = renderActionBullet(item)
      const compacted = compactFooterItem(item, elsewhere)
      elsewhere = `${elsewhere}\n${compacted.title} ${compacted.owners.join(' ')}`
      if (before !== renderActionBullet(compacted)) {
        changes.push({
          pass: 'footer-presentation',
          action: `compact-${label}`,
          before,
          after: renderActionBullet(compacted)
        })
      }
      return compacted
    })

  next.nextSteps = compactList(next.nextSteps, 'next-step')
  next.decisions = []
  next.hasDecisionsHeading = false
  return { doc: next, changes }
}

export function passSiblingParaphrase(doc: ParsedNotes): { doc: ParsedNotes; changes: PassChange[] } {
  const next = cloneDoc(doc)
  const changes: PassChange[] = []
  next.topical = next.topical.map((section) => ({
    name: section.name,
    groups: section.groups.map((group) => {
      if (group.children.length < 2) return group
      const children = dedupeSiblingChildren(group.children)
      if (children.length === group.children.length && children.every((row, index) => row === group.children[index])) {
        return group
      }
      changes.push({
        pass: 'sibling-paraphrase',
        action: 'drop-sibling-paraphrase',
        before: group.children.join('\n'),
        after: children.join('\n')
      })
      return { title: group.title, children }
    })
  }))
  return { doc: next, changes }
}

function dropEmptySections(doc: ParsedNotes): ParsedNotes {
  return {
    ...doc,
    topical: doc.topical.filter((section) => section.groups.length > 0),
    hasDecisionsHeading: doc.decisions.length > 0
  }
}

function smsSlackPresent(markdown: string): boolean {
  return /sms vs\.?\s*slack/iu.test(markdown)
}

function sectionWordCounts(doc: ParsedNotes): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const section of doc.topical) {
    counts[section.name] = countWords(renderBulletGroups(section.groups))
  }
  counts.Decisions = countWords(doc.decisions.map((item) => renderActionBullet(item)).join('\n'))
  counts['Next Steps'] = countWords(doc.nextSteps.map((item) => renderActionBullet(item)).join('\n'))
  return counts
}

export function applyArmG(markdown: string, options: ApplyArmGOptions = {}): ArmGResult {
  let doc = parseNotes(markdown)
  const inputWordCount = countWords(markdown)
  const nextStepsBefore = doc.nextSteps.length
  const decisionsBefore = doc.decisions.length
  const smsBefore = smsSlackPresent(markdown)
  const passes: PassReport[] = []
  let nsGroupingPath: NsGroupingPath = options.nsGroupingPath ?? 'deterministic'

  const runPass = (name: PassName, fn: (input: ParsedNotes) => { doc: ParsedNotes; changes: PassChange[] }): void => {
    const wordsBefore = countWords(renderNotes(doc))
    const result = fn(doc)
    doc = result.doc
    const wordsAfter = countWords(renderNotes(doc))
    passes.push({
      name,
      wordsBefore,
      wordsAfter,
      wordsRemoved: wordsBefore - wordsAfter,
      changes: result.changes
    })
  }

  runPass('id-leak-repair', (input) => passIdLeakRepair(input, options.sourceCatalog ?? {}))
  runPass('ns-vs-decisions', passNsVsDecisions)
  const clusterWordsBefore = countWords(renderNotes(doc))
  const clustered = passClusterNs(doc, {
    nsIndexGroups: options.nsIndexGroups,
    nsGroupingPath: options.nsGroupingPath
  })
  doc = clustered.doc
  const dedupedBodies = passDedupeActionBodies(doc)
  doc = dedupedBodies.doc
  nsGroupingPath = clustered.nsGroupingPath
  passes.push({
    name: 'within-ns-cluster',
    wordsBefore: clusterWordsBefore,
    wordsAfter: countWords(renderNotes(doc)),
    wordsRemoved: clusterWordsBefore - countWords(renderNotes(doc)),
    changes: [...clustered.changes, ...dedupedBodies.changes]
  })
  runPass('filler-strip', passFillerStrip)
  runPass('past-tense-demotion', passPastTenseDemote)
  runPass('misfiled-child-repair', passMisfiledChildren)
  runPass('fragment-fusion', passFragmentFusion)
  runPass('motivation-drop', passMotivationDrop)
  runPass('cross-group-body-dedup', passCrossGroupDedup)
  runPass('sibling-paraphrase', passSiblingParaphrase)
  runPass('footer-presentation', passFooterPresentation)
  doc = dropEmptySections(doc)

  const output = renderNotes(doc)
  const smsAfter = smsSlackPresent(output)
  return {
    markdown: output,
    report: {
      inputWordCount,
      outputWordCount: countWords(output),
      wordsRemoved: inputWordCount - countWords(output),
      nextStepsBefore,
      nextStepsAfter: parseActionItems(sectionBody(splitNotesDocument(output).find((chunk) => chunk.kind === 'nextSteps')?.raw ?? '')).length,
      decisionsBefore,
      decisionsAfter: doc.decisions.length,
      nsGroupingPath,
      passes,
      sectionWordCounts: sectionWordCounts(doc),
      smsSlackCaught: smsBefore && !smsAfter
    }
  }
}

export function nsCatalogId(index: number): string {
  return `n${String(index + 1).padStart(2, '0')}`
}

export function planArmGNsGroup(items: readonly ActionItem[], seed: number = DEFAULT_SEED): {
  templateName: 'ARM_G_NS_GROUP_TEMPLATE'
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  request: Omit<GenerateRequest, 'model'>
} {
  const list = items.map((item, index) => `${nsCatalogId(index)}: ${item.title}`).join('\n')
  const prompt = fillTemplate(ARM_G_NS_GROUP_TEMPLATE, { ITEMS: list })
  return {
    templateName: 'ARM_G_NS_GROUP_TEMPLATE',
    templateSha256: sha256Utf8(ARM_G_NS_GROUP_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    request: {
      prompt,
      stream: false,
      options: {
        num_ctx: ARM_G_GROUP_NUM_CTX,
        num_predict: ARM_G_GROUP_NUM_PREDICT,
        temperature: 0,
        seed,
        stop: STOP_CONDITIONS
      }
    }
  }
}

export function parseWorkstreamGroupingJson(
  raw: string,
  expectedIds: readonly string[]
): { ok: boolean; groups: string[][]; remainderIds: string[] } {
  const empty = { ok: false, groups: [] as string[][], remainderIds: [] as string[] }
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/u, '$1').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return empty
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1))
    } catch {
      return empty
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const list = (parsed as { groups?: unknown; topics?: unknown }).groups ?? (parsed as { topics?: unknown }).topics
  if (!Array.isArray(list) || list.length < 2 || list.length > 16) return empty
  const groups: string[][] = []
  const assigned = new Map<string, number>()
  for (const row of list) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return empty
    const idsRaw = (row as { ids?: unknown; item_ids?: unknown; items?: unknown }).ids
      ?? (row as { item_ids?: unknown }).item_ids
      ?? (row as { items?: unknown }).items
    if (!Array.isArray(idsRaw) || idsRaw.length === 0) return empty
    const ids: string[] = []
    for (const entry of idsRaw) {
      if (typeof entry !== 'string' || entry.trim().length === 0) return empty
      const id = entry.trim()
      assigned.set(id, (assigned.get(id) ?? 0) + 1)
      ids.push(id)
    }
    groups.push(ids)
  }
  const expected = new Set(expectedIds)
  for (const id of assigned.keys()) {
    if (!expected.has(id)) return empty
  }
  for (const count of assigned.values()) {
    if (count !== 1) return empty
  }
  const missing = expectedIds.filter((id) => (assigned.get(id) ?? 0) === 0)
  if (missing.length > expectedIds.length * 0.2) return empty
  for (const id of missing) {
    groups[groups.length - 1]?.push(id)
  }
  return { ok: true, groups, remainderIds: missing }
}

export function workstreamGroupsToIndices(
  groups: readonly string[][],
  expectedIds: readonly string[]
): number[][] {
  const indexById = new Map(expectedIds.map((id, index) => [id, index]))
  return groups
    .map((group) => group.map((id) => indexById.get(id)).filter((index): index is number => index !== undefined))
    .filter((group) => group.length > 0)
}

export async function applyArmGAsync(
  markdown: string,
  grouper?: (items: ActionItem[]) => Promise<number[][] | null>,
  options: ApplyArmGOptions = {}
): Promise<ArmGResult> {
  const afterId = passIdLeakRepair(parseNotes(markdown), options.sourceCatalog ?? {}).doc
  const afterPass1 = passNsVsDecisions(afterId).doc
  const deterministic = deterministicNsClusters(afterPass1.nextSteps)
  let nsIndexGroups: number[][] | undefined
  let nsGroupingPath: NsGroupingPath = 'deterministic'
  if (
    deterministic.length > NS_MODEL_GROUP_THRESHOLD &&
    afterPass1.nextSteps.length <= NS_MODEL_INPUT_MAX &&
    grouper
  ) {
    const override = await grouper(afterPass1.nextSteps)
    if (override && override.length > 0 && override.length <= deterministic.length) {
      nsIndexGroups = override
      nsGroupingPath = 'model'
    }
  }
  return applyArmG(markdown, { ...options, nsIndexGroups, nsGroupingPath })
}

export function stripCatalogItemIds(text: string): string {
  return text.replace(new RegExp(CATALOG_ITEM_ID_PATTERN.source, 'gu'), ' ')
}

function headingOnlyNames(markdown: string): Set<string> {
  const headings: string[] = []
  const body: string[] = []
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^#{1,6}\s+/u.test(line)) headings.push(line.replace(/^#{1,6}\s+/u, ''))
    else body.push(line)
  }
  const headingBlock = headings.join('\n')
  const bodyBlock = body.join('\n')
  const names = new Set<string>()
  for (const name of extractProperNames(markdown)) {
    const inHeading = headingBlock.toLowerCase().includes(name.toLowerCase())
    const inBody = bodyBlock.toLowerCase().includes(name.toLowerCase())
    if (inHeading && !inBody) names.add(name.toLowerCase())
  }
  return names
}

export function evaluateArmGGates(input: string, output: string, coverageItems: readonly CoverageItem[]): ArmGGates {
  const inputCoverage = scoreCoverage(stripCatalogItemIds(input), coverageItems)
  const outputCoverage = scoreCoverage(stripCatalogItemIds(output), coverageItems)
  const missingRaw = missingFacts(stripCatalogItemIds(input), output)
  const headingOnly = headingOnlyNames(input)
  const requiredNameKeys = new Set(
    leftoverGuardNames(extractProperNames(stripCatalogItemIds(input))).map((name) => name.toLowerCase())
  )
  const missing = {
    numbers: missingRaw.numbers,
    names: missingRaw.names.filter(
      (name) => !headingOnly.has(name.toLowerCase()) && requiredNameKeys.has(name.toLowerCase())
    )
  }
  const inputParsed = parseNotes(input)
  const outputParsed = parseNotes(output)
  const inputOwners = extractOwnerAttributions([...inputParsed.decisions, ...inputParsed.nextSteps])
  const outputOwners = extractOwnerAttributions([...outputParsed.decisions, ...outputParsed.nextSteps])
  const outputOwnerKeys = new Set(outputOwners.map((owner) => owner.toLowerCase()))
  const missingOwners = inputOwners.filter((owner) => !outputOwnerKeys.has(owner.toLowerCase()))
  const outputNs = outputParsed.nextSteps
  const nextStepsAllBolded =
    outputNs.length === 0 ||
    outputNs.every((item) => item.title.trim().length > 0) &&
      (splitNotesDocument(output).find((chunk) => chunk.kind === 'nextSteps')?.raw ?? '')
        .split(/\n/u)
        .filter((line) => /^\s*[-*]\s+/u.test(line))
        .every((line) => /\*\*.+\*\*/u.test(line))
  const hasDecisions =
    outputParsed.decisions.length > 0 ||
    outputParsed.hasDecisionsHeading ||
    /^##\s+Decisions\b/mu.test(output)
  const hasNextSteps = outputParsed.hasNextStepsHeading || outputParsed.nextSteps.length > 0
  const coveragePass = outputCoverage.strict + 1e-9 >= inputCoverage.strict
  const namesNumbersPass = missing.names.length === 0 && missing.numbers.length === 0
  const ownersPass = missingOwners.length === 0
  const structurePass = hasNextSteps && nextStepsAllBolded && !hasDecisions
  return {
    coveragePass,
    coverageInputStrict: inputCoverage.strict,
    coverageOutputStrict: outputCoverage.strict,
    namesNumbersPass,
    missingNames: missing.names,
    missingNumbers: missing.numbers,
    ownersPass,
    inputOwners,
    outputOwners,
    missingOwners,
    structurePass,
    hasDecisions,
    hasNextSteps,
    nextStepsAllBolded,
    allPass: coveragePass && namesNumbersPass && ownersPass && structurePass
  }
}

export function formatGateMarkdown(args: {
  meeting: string
  gates: ArmGGates
  report: ArmGReport
  coverage: { input: CoverageScore; output: CoverageScore }
  round4UncompressedWords: number
}): string {
  const { meeting, gates, report, coverage, round4UncompressedWords } = args
  const vsArmF = report.inputWordCount === 0 ? 0 : report.outputWordCount / report.inputWordCount
  const vsRound4 = round4UncompressedWords === 0 ? 0 : report.outputWordCount / round4UncompressedWords
  const sectionLines = Object.entries(report.sectionWordCounts)
    .map(([name, words]) => `- ${name}: ${words}`)
    .join('\n')
  const passLines = report.passes
    .map(
      (pass) =>
        `- ${pass.name}: ${pass.wordsBefore} → ${pass.wordsAfter} (−${pass.wordsRemoved}, ${pass.changes.length} changes)`
    )
    .join('\n')
  return `# Arm G gates — ${meeting}

## Coverage
- input strict: ${coverage.input.strict.toFixed(4)} (${coverage.input.present}/${coverage.input.n} present)
- output strict: ${coverage.output.strict.toFixed(4)} (${coverage.output.present}/${coverage.output.n} present)
- pass: ${gates.coveragePass ? 'yes' : 'NO'}

## Names / numbers (guardVersion ${ARM_G_GUARD_VERSION})
- missing names: ${gates.missingNames.length === 0 ? '(none)' : gates.missingNames.join(', ')}
- missing numbers: ${gates.missingNumbers.length === 0 ? '(none)' : gates.missingNumbers.join(', ')}
- pass: ${gates.namesNumbersPass ? 'yes' : 'NO'}

## Owners
- input: ${gates.inputOwners.join(', ') || '(none)'}
- output: ${gates.outputOwners.join(', ') || '(none)'}
- missing: ${gates.missingOwners.length === 0 ? '(none)' : gates.missingOwners.join(', ')}
- pass: ${gates.ownersPass ? 'yes' : 'NO'}

## Structure
- Decisions omitted: ${gates.hasDecisions ? 'NO' : 'yes'}
- Next Steps present: ${gates.hasNextSteps ? 'yes' : 'NO'}
- every NS item bolded: ${gates.nextStepsAllBolded ? 'yes' : 'NO'}
- pass: ${gates.structurePass ? 'yes' : 'NO'}

## Word counts
- arm-f input: ${report.inputWordCount}
- arm-g output: ${report.outputWordCount}
- vs arm-f: ${(vsArmF * 100).toFixed(1)}%
- round-4 uncompressed: ${round4UncompressedWords}
- vs round-4: ${(vsRound4 * 100).toFixed(1)}% (75% target ≤ ${Math.floor(round4UncompressedWords * 0.75)})
- Next Steps items: ${report.nextStepsBefore} → ${report.nextStepsAfter}
- NS grouping path: ${report.nsGroupingPath}
- SMS/Slack group caught: ${report.smsSlackCaught ? 'yes' : 'no'}

## Pass-by-pass words
${passLines}

## Residual words by section
${sectionLines}

## Overall
- all guards pass: ${gates.allPass ? 'yes' : 'NO'}
`
}

export function parseCoverageKeyFile(markdown: string): CoverageItem[] {
  return parseCoverageKey(markdown)
}
