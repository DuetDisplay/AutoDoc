import { watch, type FSWatcher } from 'fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  CalendarEvent,
  MeetingMetadata,
  MeetingSegments,
  Segment,
  Transcript
} from '../../shared/types'
import { decryptJSON, isEncrypted } from './crypto'
import { matchCalendarEvent, readMetadata } from './calendar-matcher'
import {
  buildRecordingTitle,
  buildRecordingTitleAliases,
  normalizeRecordingSearchText
} from './recording-title'

export const MAX_CHAT_FULL_CONTEXT_MEETINGS = 5
export const MAX_CHAT_ALL_CONTEXT_MEETINGS = 25
export const MAX_RELEVANCE_CANDIDATES = 12
const MAX_RELEVANT_NOTE_EXCERPTS_PER_MEETING = 5
const MAX_SEMANTIC_CANDIDATES = 24
const MAX_SEMANTIC_CHUNKS_PER_MEETING = 4
const MAX_EMBED_TEXT_CHARS = 1_500
const EMBED_BATCH_SIZE = 24
const SEMANTIC_SCORE_WEIGHT = 18
const INVENTORY_CACHE_TTL_MS = 60_000
const LIST_DIRECT_LIMIT = 50
const EMBEDDING_CACHE_VERSION = 1
const MAX_PERSISTED_EMBEDDING_CACHE_ENTRIES = 5_000

const QUESTION_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'and',
  'any',
  'are',
  'did',
  'each',
  'every',
  'for',
  'from',
  'get',
  'had',
  'happened',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'latest',
  'list',
  'me',
  'many',
  'meeting',
  'meetings',
  'my',
  'of',
  'on',
  'recent',
  'recording',
  'recordings',
  'show',
  'count',
  'number',
  'summarize',
  'summary',
  'tell',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'this',
  'those',
  'to',
  'was',
  'week',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with'
])

export type ChatIntent = 'count' | 'list' | 'summarize-all' | 'exact' | 'broad'
type SummaryMode = 'search' | 'full'

interface RetrievalProfile {
  wantsActions: boolean
  wantsAssignees: boolean
  wantsDeadlines: boolean
  wantsDecisions: boolean
  wantsStatus: boolean
  wantsTopics: boolean
  wantsThisWeek: boolean
}

interface InventoryCache {
  fetchedAt: number
  entries: RawInventoryEntry[]
}

interface SummaryCacheEntry {
  signature: string
  summary: MeetingSummary
}

interface EmbeddingCacheEntry {
  signature: string
  vector: number[]
  lastUsedAt: number
}

interface PersistedEmbeddingCache {
  version: typeof EMBEDDING_CACHE_VERSION
  entries: Record<string, EmbeddingCacheEntry>
}

interface MaterializedInventoryCacheEntry {
  generation: number
  entries: MeetingInventoryEntry[]
}

export interface MeetingInventoryEntry {
  id: string
  date: number
  dir: string
  title: string
  calendarTitle: string | null
  sourceName: string | null
  sourceApp: string | null
  slackChannel: string | null
  attendees: string[]
  participants: string[]
  notePreview: string | null
  transcriptStatus: 'notes' | 'transcript' | 'failed' | 'none'
  metadataSearchText: string
  aliases: string[]
  normalizedAliases: string[]
}

interface RawInventoryEntry {
  id: string
  date: number
  dir: string
  metadata: MeetingMetadata | null
  primaryBirthtime: number
  speakerLabels: string[]
  notePreview: string | null
  transcriptStatus: MeetingInventoryEntry['transcriptStatus']
}

export interface MeetingSummary {
  body: string | null
  searchText: string
  snippets: string[]
  notes: MeetingNoteItem[]
  evidence: MeetingEvidenceChunk[]
  hasNotes: boolean
  source: 'segments' | 'transcript' | 'none'
}

interface MeetingNoteItem {
  category: keyof MeetingSegments
  title: string
  content: string
  topic: string | null
  assignee: string | null
  deadline: string | null
  searchText: string
}

interface RankedMeetingSummary {
  meeting: MeetingInventoryEntry
  summary: MeetingSummary
  score: number
  lexicalScore: number
  semanticScore: number
}

interface MeetingCandidateSelection {
  selected: MeetingInventoryEntry[]
  ranked: RankedMeetingSummary[]
  constrainedPoolCount: number
  hasWindowConstraint: boolean
  confidence: CandidateConfidence
}

interface CandidateConfidence {
  shouldClarify: boolean
  reason: 'none' | 'no-match' | 'weak-top-score' | 'close-score-spread' | 'ambiguous-metadata'
  topScore: number
  secondScore: number
  scoreGap: number
  scoreRatio: number
}

export interface ChatClarificationOption {
  meetingId: string
  title: string
  subtitle: string
  date: number
  sourceName: string | null
  calendarTitle: string | null
  slackChannel: string | null
  participants: string[]
  notePreview: string | null
  score: number
}

interface MeetingEvidenceChunk {
  id: string
  source: 'note' | 'transcript'
  category: keyof MeetingSegments | 'transcript'
  title: string
  content: string
  topic: string | null
  assignee: string | null
  deadline: string | null
  searchText: string
}

export interface ChatRetrievalDiagnostics {
  intent: ChatIntent
  inventoryCount: number
  matchedCount: number
  selectedContextCount: number
  matchMode: 'direct-count' | 'direct-list' | 'large-all-guardrail' | 'exact-title' | 'ranked'
  matchedMeetingIds: string[]
  matchedTitles: string[]
  selectedMeetingIds: string[]
  selectedTitles: string[]
  inventoryElapsedMs: number
  selectionElapsedMs: number
  summaryElapsedMs: number
  cacheHits: number
  cacheMisses: number
  promptChars: number
  semanticEnabled?: boolean
  semanticCandidateCount?: number
  semanticElapsedMs?: number
  embeddingCacheHits?: number
  embeddingCacheMisses?: number
  candidateTopScore?: number
  candidateSecondScore?: number
  candidateScoreGap?: number
  candidateScoreRatio?: number
  clarificationReason?: CandidateConfidence['reason']
}

export interface ChatRetrievalResult {
  directAnswer: string | null
  context: string
  clarificationOptions?: ChatClarificationOption[]
  diagnostics: ChatRetrievalDiagnostics
}

export interface CalendarNoteAvailability {
  event: CalendarEvent
  meeting: MeetingInventoryEntry | null
  hasNotes: boolean
  source: MeetingSummary['source']
}

interface ChatRecordingIndexOptions {
  watch?: boolean
  embeddingProvider?: ChatEmbeddingProvider | null
  embeddingCachePath?: string | null
}

export interface ChatEmbeddingProvider {
  readonly model: string
  isAvailable(): Promise<boolean>
  embed(texts: string[]): Promise<number[][]>
}

interface SemanticRetrievalDiagnostics {
  enabled: boolean
  candidateCount: number
  elapsedMs: number
  embeddingCacheHits: number
  embeddingCacheMisses: number
}

export class ChatRecordingIndex {
  private inventoryCache: InventoryCache | null = null
  private inventoryGeneration = 0
  private materializedInventoryCache = new Map<string, MaterializedInventoryCacheEntry>()
  private summaryCache = new Map<string, SummaryCacheEntry>()
  private embeddingCache = new Map<string, EmbeddingCacheEntry>()
  private embeddingCacheLoaded = false
  private embeddingCachePath: string | null
  private embeddingProvider: ChatEmbeddingProvider | null
  private semanticDiagnostics = createEmptySemanticDiagnostics()
  private watcher: FSWatcher | null = null
  private watchDebounce: NodeJS.Timeout | null = null

  constructor(
    private recordingsBaseDir: string,
    options: ChatRecordingIndexOptions = {}
  ) {
    this.embeddingProvider = options.embeddingProvider ?? null
    this.embeddingCachePath = options.embeddingCachePath ?? null
    if (options.watch) this.startWatcher()
  }

  invalidate(): void {
    this.inventoryCache = null
    this.inventoryGeneration += 1
    this.materializedInventoryCache.clear()
    this.embeddingCache.clear()
    this.embeddingCacheLoaded = false
  }

  dispose(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce)
      this.watchDebounce = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private startWatcher(): void {
    try {
      this.watcher = watch(this.recordingsBaseDir, { recursive: true }, () => {
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => this.invalidate(), 100)
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null
    }
  }

  /**
   * Deterministic inventory accessor used by the tool-calling agent (Ask AI v2).
   *
   * Returns the full materialized recording inventory, most-recent-first. This is
   * the single source of truth for counts and ordered lists, so the agent's
   * count/list tools never depend on the language model and can never report a
   * fabricated number (the AD-83 "you have 0 recordings" class of bug).
   */
  async listInventory(
    recentEvents: CalendarEvent[] = [],
    forceRefresh = true
  ): Promise<MeetingInventoryEntry[]> {
    return this.getInventory(recentEvents, forceRefresh)
  }

  async buildExactTitleContext(
    question: string,
    recentEvents: CalendarEvent[] = []
  ): Promise<ChatRetrievalResult | null> {
    this.semanticDiagnostics = createEmptySemanticDiagnostics()
    const startedAt = Date.now()
    // Title lookups must see a just-finished recording (AD-83: "not detecting
    // some recordings by title"), so bypass the watcher-backed TTL cache.
    const inventory = await this.getInventory(recentEvents, true)
    const inventoryElapsedMs = Date.now() - startedAt
    const selectionStartedAt = Date.now()
    const exactMatches = findExactTitleMatches(inventory, question)
    if (exactMatches.length === 0) return null

    return this.buildExactMatchResult({
      question,
      inventory,
      selected: exactMatches,
      inventoryElapsedMs,
      selectionElapsedMs: Date.now() - selectionStartedAt
    })
  }

  async buildContext(
    question: string,
    recentEvents: CalendarEvent[]
  ): Promise<ChatRetrievalResult> {
    this.semanticDiagnostics = createEmptySemanticDiagnostics()
    const startedAt = Date.now()
    const intent = detectChatIntent(question)
    // Inventory questions (count/list/summarize-all) must reflect a just-finished
    // recording immediately rather than wait out the watcher-backed TTL cache.
    const wantsLatest = isLatestRecordingQuery(question)
    const requiresFreshInventory =
      intent === 'count' || intent === 'list' || intent === 'summarize-all' || wantsLatest
    const inventory = await this.getInventory(recentEvents, requiresFreshInventory)
    const inventoryElapsedMs = Date.now() - startedAt
    const selectionStartedAt = Date.now()

    if (intent === 'count') {
      const matched = filterInventoryForDirectIntent(inventory, question)
      const directAnswer = `You have ${matched.length} recording${matched.length === 1 ? '' : 's'}.`
      return this.result({
        intent,
        inventory,
        directAnswer,
        context: '',
        matched,
        selected: [],
        matchMode: 'direct-count',
        inventoryElapsedMs,
        selectionElapsedMs: Date.now() - selectionStartedAt,
        summaryElapsedMs: 0,
        cacheHits: 0,
        cacheMisses: 0
      })
    }

    if (intent === 'list') {
      const matched = filterInventoryForDirectIntent(inventory, question)
      const directAnswer = formatRecordingListAnswer(matched)
      return this.result({
        intent,
        inventory,
        directAnswer,
        context: '',
        matched,
        selected: [],
        matchMode: 'direct-list',
        inventoryElapsedMs,
        selectionElapsedMs: Date.now() - selectionStartedAt,
        summaryElapsedMs: 0,
        cacheHits: 0,
        cacheMisses: 0
      })
    }

    if (intent === 'summarize-all' && inventory.length > MAX_CHAT_ALL_CONTEXT_MEETINGS) {
      const directAnswer = formatLargeAllGuardrailAnswer(inventory)
      return this.result({
        intent,
        inventory,
        directAnswer,
        context: '',
        matched: inventory,
        selected: [],
        matchMode: 'large-all-guardrail',
        inventoryElapsedMs,
        selectionElapsedMs: Date.now() - selectionStartedAt,
        summaryElapsedMs: 0,
        cacheHits: 0,
        cacheMisses: 0
      })
    }

    if (wantsLatest && inventory.length > 0) {
      // Inventory is ordered most-recent-first, so entry 0 is the newest.
      return this.buildExactMatchResult({
        question,
        inventory,
        selected: [inventory[0]],
        inventoryElapsedMs,
        selectionElapsedMs: Date.now() - selectionStartedAt
      })
    }

    const exactMatches = findExactTitleMatches(inventory, question)
    if (exactMatches.length > 0) {
      return this.buildExactMatchResult({
        question,
        inventory,
        selected: exactMatches,
        inventoryElapsedMs,
        selectionElapsedMs: Date.now() - selectionStartedAt
      })
    }

    const candidateSelection =
      intent === 'summarize-all'
        ? null
        : await this.selectRankedMeetingCandidates(inventory, question)
    const selected = intent === 'summarize-all' ? inventory : (candidateSelection?.selected ?? [])
    const matched = selected
    const selectionElapsedMs = Date.now() - selectionStartedAt
    const summaryStartedAt = Date.now()
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }

    if (candidateSelection) {
      const clarification = formatMeetingClarification(question, candidateSelection)
      if (clarification) {
        return this.result({
          intent,
          inventory,
          directAnswer: clarification.answer,
          context: '',
          matched,
          selected,
          matchMode: 'ranked',
          inventoryElapsedMs,
          selectionElapsedMs,
          summaryElapsedMs: 0,
          cacheHits: 0,
          cacheMisses: 0,
          clarificationOptions: clarification.options,
          candidateConfidence: candidateSelection.confidence
        })
      }

      if (shouldAnswerResolvedSummaryDirectly(question, candidateSelection)) {
        const directAnswer = await this.formatExactSummaryAnswer({
          selected,
          question,
          summaryStats
        })
        return this.result({
          intent,
          inventory,
          directAnswer,
          context: '',
          matched,
          selected,
          matchMode: 'ranked',
          inventoryElapsedMs,
          selectionElapsedMs,
          summaryElapsedMs: Date.now() - summaryStartedAt,
          cacheHits: summaryStats.cacheHits,
          cacheMisses: summaryStats.cacheMisses,
          candidateConfidence: candidateSelection.confidence
        })
      }
    }

    if (isActionItemQuestion(question)) {
      const directAnswer = await this.formatAggregateActionAnswer(selected, summaryStats)
      return this.result({
        intent,
        inventory,
        directAnswer,
        context: '',
        matched,
        selected,
        matchMode: 'ranked',
        inventoryElapsedMs,
        selectionElapsedMs,
        summaryElapsedMs: Date.now() - summaryStartedAt,
        cacheHits: summaryStats.cacheHits,
        cacheMisses: summaryStats.cacheMisses
      })
    }

    if (isStructuredActionFactQuestion(question)) {
      const directAnswer = await this.formatStructuredActionFactAnswer(
        selected,
        question,
        summaryStats
      )
      if (directAnswer) {
        return this.result({
          intent,
          inventory,
          directAnswer,
          context: '',
          matched,
          selected,
          matchMode: 'ranked',
          inventoryElapsedMs,
          selectionElapsedMs,
          summaryElapsedMs: Date.now() - summaryStartedAt,
          cacheHits: summaryStats.cacheHits,
          cacheMisses: summaryStats.cacheMisses
        })
      }
    }

    if (isMultiMeetingSynthesisQuestion(question) && selected.length > 1) {
      const directAnswer = await this.formatMultiMeetingSynthesisAnswer(
        selected,
        question,
        summaryStats
      )
      if (directAnswer) {
        return this.result({
          intent,
          inventory,
          directAnswer,
          context: '',
          matched,
          selected,
          matchMode: 'ranked',
          inventoryElapsedMs,
          selectionElapsedMs,
          summaryElapsedMs: Date.now() - summaryStartedAt,
          cacheHits: summaryStats.cacheHits,
          cacheMisses: summaryStats.cacheMisses,
          candidateConfidence: candidateSelection?.confidence
        })
      }
    }

    const context = await this.formatMeetingContext({
      inventory,
      selected,
      question,
      includeTranscriptFallback: true,
      includeFullNotes: intent === 'summarize-all',
      summaryStats
    })

    return this.result({
      intent: exactMatches.length > 0 ? 'exact' : intent,
      inventory,
      directAnswer: null,
      context,
      matched,
      selected,
      matchMode: 'ranked',
      inventoryElapsedMs,
      selectionElapsedMs,
      summaryElapsedMs: Date.now() - summaryStartedAt,
      cacheHits: summaryStats.cacheHits,
      cacheMisses: summaryStats.cacheMisses
    })
  }

  async buildContextForMeetingIds(
    question: string,
    meetingIds: string[],
    recentEvents: CalendarEvent[] = []
  ): Promise<ChatRetrievalResult> {
    this.semanticDiagnostics = createEmptySemanticDiagnostics()
    const startedAt = Date.now()
    const inventory = await this.getInventory(recentEvents)
    const inventoryElapsedMs = Date.now() - startedAt
    const selectionStartedAt = Date.now()
    const selected = meetingIds
      .map((id) => inventory.find((meeting) => meeting.id === id))
      .filter((meeting): meeting is MeetingInventoryEntry => meeting != null)
    const selectionElapsedMs = Date.now() - selectionStartedAt
    const summaryStartedAt = Date.now()
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }

    if (shouldAnswerExactSummaryDirectly(question)) {
      const directAnswer = await this.formatExactSummaryAnswer({
        selected,
        question,
        summaryStats
      })
      return this.result({
        intent: 'broad',
        inventory,
        directAnswer,
        context: '',
        matched: selected,
        selected,
        matchMode: 'ranked',
        inventoryElapsedMs,
        selectionElapsedMs,
        summaryElapsedMs: Date.now() - summaryStartedAt,
        cacheHits: summaryStats.cacheHits,
        cacheMisses: summaryStats.cacheMisses
      })
    }

    const context = await this.formatMeetingContext({
      inventory,
      selected,
      question,
      includeTranscriptFallback: true,
      includeFullNotes: true,
      summaryStats
    })

    return this.result({
      intent: 'broad',
      inventory,
      directAnswer: null,
      context,
      matched: selected,
      selected,
      matchMode: 'ranked',
      inventoryElapsedMs,
      selectionElapsedMs,
      summaryElapsedMs: Date.now() - summaryStartedAt,
      cacheHits: summaryStats.cacheHits,
      cacheMisses: summaryStats.cacheMisses
    })
  }

  async buildContextForCalendarEvents(
    question: string,
    events: CalendarEvent[],
    recentEvents: CalendarEvent[] = []
  ): Promise<ChatRetrievalResult> {
    this.semanticDiagnostics = createEmptySemanticDiagnostics()
    const startedAt = Date.now()
    const inventory = await this.getInventory(recentEvents)
    const inventoryElapsedMs = Date.now() - startedAt
    const selectionStartedAt = Date.now()
    const matches = findBestCalendarRecordingMatches(events, inventory)
    const selected = matches
      .map((match) => match.meeting)
      .filter((meeting): meeting is MeetingInventoryEntry => meeting != null)
    const selectionElapsedMs = Date.now() - selectionStartedAt
    const summaryStartedAt = Date.now()
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }

    if (isActionItemQuestion(question)) {
      const directAnswer = await this.formatAggregateActionAnswer(selected, summaryStats)
      return this.result({
        intent: 'broad',
        inventory,
        directAnswer,
        context: '',
        matched: selected,
        selected,
        matchMode: 'ranked',
        inventoryElapsedMs,
        selectionElapsedMs,
        summaryElapsedMs: Date.now() - summaryStartedAt,
        cacheHits: summaryStats.cacheHits,
        cacheMisses: summaryStats.cacheMisses
      })
    }

    const context = await this.formatMeetingContext({
      inventory,
      selected,
      question: `${question} Answer only from recordings matched to the previous calendar meeting list.`,
      includeTranscriptFallback: true,
      includeFullNotes: true,
      summaryStats,
      scopeDescription: `${events.length} calendar meetings from the previous answer`
    })

    return this.result({
      intent: 'broad',
      inventory,
      directAnswer: null,
      context,
      matched: selected,
      selected,
      matchMode: 'ranked',
      inventoryElapsedMs,
      selectionElapsedMs,
      summaryElapsedMs: Date.now() - summaryStartedAt,
      cacheHits: summaryStats.cacheHits,
      cacheMisses: summaryStats.cacheMisses
    })
  }

  async buildNoteAvailabilityForCalendarEvents(
    events: CalendarEvent[],
    recentEvents: CalendarEvent[] = []
  ): Promise<ChatRetrievalResult> {
    this.semanticDiagnostics = createEmptySemanticDiagnostics()
    const startedAt = Date.now()
    const inventory = await this.getInventory(recentEvents)
    const inventoryElapsedMs = Date.now() - startedAt
    const selectionStartedAt = Date.now()
    const matches = findBestCalendarRecordingMatches(events, inventory)
    const selected = matches
      .map((match) => match.meeting)
      .filter((meeting): meeting is MeetingInventoryEntry => meeting != null)
    const selectionElapsedMs = Date.now() - selectionStartedAt
    const summaryStartedAt = Date.now()
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }
    const availability: CalendarNoteAvailability[] = []

    for (const match of matches) {
      if (!match.meeting) {
        availability.push({
          event: match.event,
          meeting: null,
          hasNotes: false,
          source: 'none'
        })
        continue
      }

      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(match.meeting, 'search')
      if (this.getCacheHitCount() > beforeHits) {
        summaryStats.cacheHits += 1
      } else {
        summaryStats.cacheMisses += 1
      }

      availability.push({
        event: match.event,
        meeting: match.meeting,
        hasNotes: summary.source === 'segments' && summary.hasNotes,
        source: summary.source
      })
    }

    const meetingsWithNotes = availability
      .filter((item) => item.hasNotes && item.meeting)
      .map((item) => item.meeting as MeetingInventoryEntry)
    const directAnswer = formatCalendarNoteAvailabilityAnswer(availability)

    return this.result({
      intent: 'broad',
      inventory,
      directAnswer,
      context: '',
      matched: selected,
      selected: meetingsWithNotes,
      matchMode: 'ranked',
      inventoryElapsedMs,
      selectionElapsedMs,
      summaryElapsedMs: Date.now() - summaryStartedAt,
      cacheHits: summaryStats.cacheHits,
      cacheMisses: summaryStats.cacheMisses
    })
  }

  private async buildExactMatchResult(params: {
    question: string
    inventory: MeetingInventoryEntry[]
    selected: MeetingInventoryEntry[]
    inventoryElapsedMs: number
    selectionElapsedMs: number
  }): Promise<ChatRetrievalResult> {
    const summaryStartedAt = Date.now()
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }

    if (shouldAnswerExactSummaryDirectly(params.question)) {
      const directAnswer = await this.formatExactSummaryAnswer({
        selected: params.selected,
        question: params.question,
        summaryStats
      })
      return this.result({
        intent: 'exact',
        inventory: params.inventory,
        directAnswer,
        context: '',
        matched: params.selected,
        selected: params.selected,
        matchMode: 'exact-title',
        inventoryElapsedMs: params.inventoryElapsedMs,
        selectionElapsedMs: params.selectionElapsedMs,
        summaryElapsedMs: Date.now() - summaryStartedAt,
        cacheHits: summaryStats.cacheHits,
        cacheMisses: summaryStats.cacheMisses
      })
    }

    const context = await this.formatMeetingContext({
      inventory: params.inventory,
      selected: params.selected,
      question: params.question,
      includeTranscriptFallback: true,
      includeFullNotes: true,
      summaryStats
    })

    return this.result({
      intent: 'exact',
      inventory: params.inventory,
      directAnswer: null,
      context,
      matched: params.selected,
      selected: params.selected,
      matchMode: 'exact-title',
      inventoryElapsedMs: params.inventoryElapsedMs,
      selectionElapsedMs: params.selectionElapsedMs,
      summaryElapsedMs: Date.now() - summaryStartedAt,
      cacheHits: summaryStats.cacheHits,
      cacheMisses: summaryStats.cacheMisses
    })
  }

  private async getInventory(
    recentEvents: CalendarEvent[],
    forceRefresh = false
  ): Promise<MeetingInventoryEntry[]> {
    const rawEntries = await this.getRawInventory(forceRefresh)
    const cacheKey = buildCalendarSignature(recentEvents)
    const cached = this.materializedInventoryCache.get(cacheKey)
    if (cached?.generation === this.inventoryGeneration) return cached.entries

    const entries = rawEntries
      .map((entry) => materializeInventoryEntry(entry, recentEvents))
      .sort((a, b) => b.date - a.date)
    this.materializedInventoryCache.set(cacheKey, {
      generation: this.inventoryGeneration,
      entries
    })
    return entries
  }

  private async getRawInventory(forceRefresh = false): Promise<RawInventoryEntry[]> {
    // macOS recursive fs.watch can miss nested writes (a recording finishes
    // writing its files over time), so the TTL cache can lag a just-finished
    // recording by up to INVENTORY_CACHE_TTL_MS. Count/list/title lookups are the
    // exact paths QA saw report a stale count (AD-83: "took three attempts"), so
    // those callers force a fresh disk scan rather than trust the watcher.
    if (
      !forceRefresh &&
      this.inventoryCache &&
      Date.now() - this.inventoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS
    ) {
      return this.inventoryCache.entries
    }

    let dirs: string[]
    try {
      const dirents = await readdir(this.recordingsBaseDir, { withFileTypes: true })
      dirs = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name)
    } catch {
      this.inventoryCache = { fetchedAt: Date.now(), entries: [] }
      return []
    }

    const entries = (
      await Promise.all(dirs.map((meetingId) => this.readRawInventoryEntry(meetingId)))
    )
      .filter((entry): entry is RawInventoryEntry => entry != null)
      .sort((a, b) => b.date - a.date)

    this.inventoryCache = { fetchedAt: Date.now(), entries }
    this.inventoryGeneration += 1
    this.materializedInventoryCache.clear()
    return entries
  }

  private async readRawInventoryEntry(meetingId: string): Promise<RawInventoryEntry | null> {
    const meetingDir = join(this.recordingsBaseDir, meetingId)

    const primaryStat =
      (await stat(join(meetingDir, 'mic.webm')).catch(() => null)) ??
      (await stat(join(meetingDir, 'system.webm')).catch(() => null)) ??
      (await stat(join(meetingDir, 'audio.webm')).catch(() => null)) ??
      (await stat(join(meetingDir, 'transcript.json')).catch(() => null)) ??
      (await stat(join(meetingDir, 'segments.json')).catch(() => null))

    if (!primaryStat) return null

    const metadata = await readMetadata(meetingDir)
    const [speakerLabels, notePreview, transcriptStatus] = await Promise.all([
      readInventorySpeakerLabels(meetingDir),
      readInventoryNotePreview(meetingDir),
      readInventoryTranscriptStatus(meetingDir)
    ])

    return {
      id: meetingId,
      date: metadata?.startedAt ?? primaryStat.birthtime.getTime(),
      dir: meetingDir,
      metadata,
      primaryBirthtime: primaryStat.birthtime.getTime(),
      speakerLabels,
      notePreview,
      transcriptStatus
    }
  }

  private async selectRankedMeetingCandidates(
    inventory: MeetingInventoryEntry[],
    question: string
  ): Promise<MeetingCandidateSelection> {
    const hasWindowConstraint = hasQuestionWindowCue(question)
    const windowedMeetings = filterMeetingsForQuestionWindow(inventory, question)
    const poolSource = hasWindowConstraint
      ? windowedMeetings
      : windowedMeetings.length > 0
        ? windowedMeetings
        : inventory
    const summaryStats = { cacheHits: 0, cacheMisses: 0 }
    const actionItemQuestion =
      isActionItemQuestion(question) || isStructuredActionFactQuestion(question)
    const skipSemantic =
      actionItemQuestion || (hasExplicitMeetingTypeCue(question) && poolSource.length <= 8)
    const fullyRanked = await this.rankMeetingsWithSummaries(poolSource, question, summaryStats, {
      semantic: !skipSemantic
    })
    let selected: MeetingInventoryEntry[]
    if (actionItemQuestion) {
      const hasActionEvidence = (summary: MeetingSummary): boolean =>
        summary.evidence.some(
          (chunk) => chunk.category === 'actionItems' || isActionLikeEvidence(chunk)
        )
      const actionMatches = fullyRanked.filter(
        ({ summary, score }) => score > 0 && hasActionEvidence(summary)
      )
      // A generic follow-up question ("what do I need to follow up on?") has no
      // subject term to match lexically, so actionMatches is empty even though
      // the user clearly wants their open action items. Detect "generic" as: the
      // only leftover subject terms are action-item vocabulary. For those, surface
      // every meeting that actually has action items rather than answering "I did
      // not find any". A specific subject ("action items about pricing") still
      // returns honestly empty so we never fabricate relevance.
      const subjectTerms = extractQuestionTerms(
        stripQuestionScaffolding(normalizeRecordingSearchText(question))
      )
      const isGenericActionQuestion =
        subjectTerms.filter(
          (term) => !ACTION_ITEM_VOCABULARY.has(term) && !GENERIC_FOLLOWUP_FILLER.has(term)
        ).length === 0
      const actionCandidates =
        actionMatches.length > 0
          ? actionMatches
          : isGenericActionQuestion
            ? fullyRanked.filter(({ summary }) => hasActionEvidence(summary))
            : []
      if (actionCandidates.length > 0) {
        selected = actionCandidates
          .slice(0, MAX_CHAT_ALL_CONTEXT_MEETINGS)
          .map(({ meeting }) => meeting)
        return {
          selected,
          ranked: fullyRanked,
          constrainedPoolCount: poolSource.length,
          hasWindowConstraint,
          confidence: evaluateCandidateConfidence(fullyRanked, selected, question)
        }
      }
    }
    const relevant = filterRelevantRankedMeetings(fullyRanked)

    const shouldUseFallbackCandidates =
      !hasSpecificSubjectQuestion(question) ||
      hasExplicitMeetingTypeCue(question) ||
      (hasWindowConstraint &&
        (isGeneralSummaryQuestion(question) ||
          isActionItemQuestion(question) ||
          isMultiMeetingSynthesisQuestion(question)))
    selected = (relevant.length > 0 ? relevant : shouldUseFallbackCandidates ? fullyRanked : [])
      .slice(0, Math.min(MAX_CHAT_FULL_CONTEXT_MEETINGS, MAX_RELEVANCE_CANDIDATES))
      .map(({ meeting }) => meeting)

    return {
      selected,
      ranked: fullyRanked,
      constrainedPoolCount: poolSource.length,
      hasWindowConstraint,
      confidence: evaluateCandidateConfidence(fullyRanked, selected, question)
    }
  }

  private async rankMeetingsWithSummaries(
    meetings: MeetingInventoryEntry[],
    question: string,
    summaryStats: { cacheHits: number; cacheMisses: number },
    options: { semantic?: boolean } = {}
  ): Promise<RankedMeetingSummary[]> {
    const profile = buildRetrievalProfile(question)
    const summaries = await Promise.all(
      meetings.map(async (meeting) => {
        const beforeHits = this.getCacheHitCount()
        const summary = await this.loadMeetingSummary(meeting, 'search')
        if (this.getCacheHitCount() > beforeHits) {
          summaryStats.cacheHits += 1
        } else {
          summaryStats.cacheMisses += 1
        }

        const lexicalScore = scoreMeetingForRetrieval(meeting, summary, question, profile)
        return {
          meeting,
          summary,
          score: lexicalScore,
          lexicalScore,
          semanticScore: 0
        }
      })
    )

    const lexicalRanked = summaries.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return b.meeting.date - a.meeting.date
    })

    if (options.semantic === false) return lexicalRanked
    if (hasStrongLexicalRetrievalSignal(lexicalRanked, question)) return lexicalRanked
    return this.rerankMeetingsSemantically(lexicalRanked, question)
  }

  private async rerankMeetingsSemantically(
    ranked: RankedMeetingSummary[],
    question: string
  ): Promise<RankedMeetingSummary[]> {
    const provider = this.embeddingProvider
    if (!provider || ranked.length <= 1) return ranked

    const startedAt = Date.now()
    try {
      if (!(await provider.isAvailable())) {
        this.semanticDiagnostics = {
          ...createEmptySemanticDiagnostics(),
          enabled: false,
          elapsedMs: Date.now() - startedAt
        }
        return ranked
      }

      await this.loadPersistentEmbeddingCache()

      const candidates = selectSemanticCandidates(ranked)
      const queryText = buildQueryEmbeddingText(question)
      const querySignature = hashText(queryText)
      const queryCacheKey = buildQueryEmbeddingCacheKey(provider.model, queryText)
      let queryCacheMissed = false
      let queryVector = this.embeddingCache.get(queryCacheKey)?.vector
      const cachedQuery = this.embeddingCache.get(queryCacheKey)
      if (cachedQuery?.signature === querySignature) {
        cachedQuery.lastUsedAt = Date.now()
        queryVector = cachedQuery.vector
      } else {
        queryVector = (await provider.embed([queryText]))[0]
        if (queryVector) {
          this.embeddingCache.set(queryCacheKey, {
            signature: querySignature,
            vector: queryVector,
            lastUsedAt: Date.now()
          })
          queryCacheMissed = true
        }
      }
      if (!queryVector) return ranked

      const profile = buildRetrievalProfile(question)
      const chunkRefs = candidates.flatMap((candidate) =>
        candidate.summary.evidence
          .map((chunk) => ({
            chunk,
            score: scoreEvidenceChunkForRetrieval(chunk, question, profile)
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_SEMANTIC_CHUNKS_PER_MEETING)
          .map(({ chunk }) => ({
            meetingId: candidate.meeting.id,
            chunk,
            text: buildChunkEmbeddingText(candidate.meeting, chunk)
          }))
      )
      const missing = chunkRefs.filter((ref) => {
        const cacheKey = buildEmbeddingCacheKey(provider.model, ref.meetingId, ref.chunk, ref.text)
        const cached = this.embeddingCache.get(cacheKey)
        if (cached?.signature === hashText(ref.text)) {
          cached.lastUsedAt = Date.now()
          this.semanticDiagnostics.embeddingCacheHits += 1
          return false
        }
        return true
      })

      for (let index = 0; index < missing.length; index += EMBED_BATCH_SIZE) {
        const batch = missing.slice(index, index + EMBED_BATCH_SIZE)
        const vectors = await provider.embed(batch.map((ref) => ref.text))
        vectors.forEach((vector, vectorIndex) => {
          const ref = batch[vectorIndex]
          if (!ref) return
          this.embeddingCache.set(
            buildEmbeddingCacheKey(provider.model, ref.meetingId, ref.chunk, ref.text),
            {
              signature: hashText(ref.text),
              vector,
              lastUsedAt: Date.now()
            }
          )
          this.semanticDiagnostics.embeddingCacheMisses += 1
        })
      }

      if (missing.length > 0 || queryCacheMissed) {
        await this.savePersistentEmbeddingCache(provider.model)
      }

      const semanticByMeeting = new Map<string, number>()
      for (const ref of chunkRefs) {
        const cached = this.embeddingCache.get(
          buildEmbeddingCacheKey(provider.model, ref.meetingId, ref.chunk, ref.text)
        )
        if (!cached) continue
        cached.lastUsedAt = Date.now()
        const similarity = cosineSimilarity(queryVector, cached.vector)
        const categoryBoost = semanticCategoryBoost(ref.chunk, question)
        const score = Math.max(0, similarity) * SEMANTIC_SCORE_WEIGHT + categoryBoost
        semanticByMeeting.set(
          ref.meetingId,
          Math.max(semanticByMeeting.get(ref.meetingId) ?? 0, score)
        )
      }

      const reranked = ranked.map((entry) => {
        const semanticScore = semanticByMeeting.get(entry.meeting.id) ?? 0
        return {
          ...entry,
          semanticScore,
          score: entry.lexicalScore + semanticScore
        }
      })

      this.semanticDiagnostics = {
        ...this.semanticDiagnostics,
        enabled: true,
        candidateCount: candidates.length,
        elapsedMs: Date.now() - startedAt
      }

      return reranked.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        if (a.semanticScore !== b.semanticScore) return b.semanticScore - a.semanticScore
        return b.meeting.date - a.meeting.date
      })
    } catch {
      this.semanticDiagnostics = {
        ...this.semanticDiagnostics,
        enabled: false,
        candidateCount: 0,
        elapsedMs: Date.now() - startedAt
      }
      return ranked
    }
  }

  private async loadPersistentEmbeddingCache(): Promise<void> {
    if (this.embeddingCacheLoaded) return
    this.embeddingCacheLoaded = true
    if (!this.embeddingCachePath) return

    try {
      const raw = await readFile(this.embeddingCachePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<PersistedEmbeddingCache>
      if (parsed.version !== EMBEDDING_CACHE_VERSION || parsed.entries == null) return

      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!isValidEmbeddingCacheEntry(entry)) continue
        this.embeddingCache.set(key, {
          signature: entry.signature,
          vector: entry.vector,
          lastUsedAt: entry.lastUsedAt
        })
      }
    } catch {
      // Cache persistence is an optimization; retrieval should never depend on it.
    }
  }

  private async savePersistentEmbeddingCache(model: string): Promise<void> {
    if (!this.embeddingCachePath) return

    try {
      const entries = Array.from(this.embeddingCache.entries())
        .filter(([key, entry]) => key.startsWith(`${model}:`) && isValidEmbeddingCacheEntry(entry))
        .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
        .slice(0, MAX_PERSISTED_EMBEDDING_CACHE_ENTRIES)

      const payload: PersistedEmbeddingCache = {
        version: EMBEDDING_CACHE_VERSION,
        entries: Object.fromEntries(entries)
      }
      const tempPath = `${this.embeddingCachePath}.${process.pid}.tmp`
      await mkdir(dirname(this.embeddingCachePath), { recursive: true })
      await writeFile(tempPath, JSON.stringify(payload))
      await rename(tempPath, this.embeddingCachePath)
    } catch {
      // Best effort only; a failed cache write should not slow or break chat.
    }
  }

  private async formatMeetingContext(params: {
    inventory: MeetingInventoryEntry[]
    selected: MeetingInventoryEntry[]
    question: string
    includeTranscriptFallback: boolean
    includeFullNotes: boolean
    summaryStats: { cacheHits: number; cacheMisses: number }
    scopeDescription?: string
  }): Promise<string> {
    if (params.selected.length === 0) {
      const scope = params.scopeDescription ? ` Scope: ${params.scopeDescription}.` : ''
      return `Recording inventory: ${params.inventory.length} total recordings.${scope}\nNo matching meeting data available.`
    }

    const contextParts = [
      `Recording inventory: ${params.inventory.length} total recordings. ${params.selected.length} recording${params.selected.length === 1 ? '' : 's'} selected for this answer.${params.scopeDescription ? ` Scope: ${params.scopeDescription}.` : ''}`
    ]

    for (const meeting of params.selected) {
      const dateStr = new Date(meeting.date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(
        meeting,
        params.includeTranscriptFallback ? 'full' : 'search'
      )
      if (this.getCacheHitCount() > beforeHits) {
        params.summaryStats.cacheHits += 1
      } else {
        params.summaryStats.cacheMisses += 1
      }

      let meetingContext = `## Meeting: ${meeting.title}\nMeeting ID: ${meeting.id}\nDate: ${dateStr}\n`
      if (meeting.calendarTitle && !meeting.title.includes(meeting.calendarTitle)) {
        meetingContext += `Calendar match: ${meeting.calendarTitle}\n`
      }
      const metadataLines = formatMeetingMetadataForContext(meeting)
      if (metadataLines) meetingContext += metadataLines
      if (summary.body) {
        meetingContext +=
          '\nUse the structured notes first. Use the transcript excerpt only as fallback or supporting detail.\n'
        const evidence = formatRelevantNoteEvidence(summary, params.question)
        if (evidence) {
          meetingContext += `\nMost relevant structured notes for the question:\n${evidence}\n`
        }
        if (params.includeFullNotes || !evidence) {
          meetingContext += `\n${limitMeetingBody(summary.body)}`
        }
      } else {
        meetingContext += '\nNo transcript or meeting notes are available for this meeting yet.'
      }
      contextParts.push(meetingContext)
    }

    return contextParts.join('\n\n---\n\n')
  }

  private async formatExactSummaryAnswer(params: {
    selected: MeetingInventoryEntry[]
    question: string
    summaryStats: { cacheHits: number; cacheMisses: number }
  }): Promise<string> {
    const oneSentence = /\b(one sentence|briefly|quick summary|short summary)\b/.test(
      normalizeRecordingSearchText(params.question)
    )
    const sections: string[] = []

    for (const meeting of params.selected) {
      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(meeting, 'full')
      if (this.getCacheHitCount() > beforeHits) {
        params.summaryStats.cacheHits += 1
      } else {
        params.summaryStats.cacheMisses += 1
      }

      if (!summary.body) {
        sections.push(
          `I found ${meeting.title}, but no transcript or meeting notes are available for it yet.`
        )
        continue
      }

      if (oneSentence) {
        sections.push(`${meeting.title}: ${formatOneSentenceSummary(summary)}`)
      } else {
        sections.push(`Summary of ${meeting.title}:\n\n${formatDirectSummaryBullets(summary)}`)
      }
    }

    return sections.join('\n\n')
  }

  private async formatAggregateActionAnswer(
    selected: MeetingInventoryEntry[],
    summaryStats: { cacheHits: number; cacheMisses: number }
  ): Promise<string> {
    if (selected.length === 0) {
      return 'I did not find matching local meeting notes with action items for that question.'
    }

    const sections: string[] = []
    let actionCount = 0

    for (const meeting of selected) {
      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(meeting, 'search')
      if (this.getCacheHitCount() > beforeHits) {
        summaryStats.cacheHits += 1
      } else {
        summaryStats.cacheMisses += 1
      }

      const actions = summary.evidence.filter(
        (chunk) => chunk.category === 'actionItems' || isActionLikeEvidence(chunk)
      )
      if (actions.length === 0) continue

      actionCount += actions.length
      const dateStr = new Date(meeting.date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
      const actionLines = actions.map((chunk) => `- ${formatEvidenceChunkForContext(chunk)}`)
      sections.push(`From ${meeting.title} (${dateStr}):\n${actionLines.join('\n')}`)
    }

    if (actionCount === 0) {
      return 'I found matching meetings, but their local structured notes do not list action items.'
    }

    const cappedPrefix =
      selected.length >= MAX_CHAT_ALL_CONTEXT_MEETINGS
        ? `Here are the first ${selected.length} matching action-item meetings I found.`
        : `I found ${actionCount} action item${actionCount === 1 ? '' : 's'} in ${selected.length} matching meeting${selected.length === 1 ? '' : 's'}.`

    return `${cappedPrefix}\n\n${sections.join('\n\n')}`
  }

  private async formatStructuredActionFactAnswer(
    selected: MeetingInventoryEntry[],
    question: string,
    summaryStats: { cacheHits: number; cacheMisses: number }
  ): Promise<string | null> {
    const matches: Array<{
      meeting: MeetingInventoryEntry
      chunk: MeetingEvidenceChunk
      score: number
    }> = []

    const normalizedQuestion = normalizeRecordingSearchText(question)
    const asksDueDate = /\b(due|deadline|when)\b/.test(normalizedQuestion)
    const asksOwner = /\b(owner|owns|assigned|assignee|responsible)\b/.test(normalizedQuestion)

    for (const meeting of selected) {
      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(meeting, 'search')
      if (this.getCacheHitCount() > beforeHits) {
        summaryStats.cacheHits += 1
      } else {
        summaryStats.cacheMisses += 1
      }

      for (const chunk of summary.evidence) {
        if (chunk.category !== 'actionItems' && !isActionLikeEvidence(chunk)) continue
        if (asksDueDate && !chunk.deadline) continue
        if (asksOwner && !chunk.assignee) continue
        const score = scoreTextRelevance(`${meeting.title} ${chunk.searchText}`, question)
        if (score > 0) matches.push({ meeting, chunk, score })
      }
    }

    if (matches.length === 0) return null

    matches.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return b.meeting.date - a.meeting.date
    })

    const bestScore = matches[0]?.score ?? 0
    const topMatches = matches.filter((match) => match.score >= bestScore).slice(0, 3)
    const lines = topMatches.map(({ meeting, chunk }) => {
      const facts: string[] = []
      if (asksOwner && chunk.assignee) facts.push(`Owner: ${chunk.assignee}`)
      if (asksDueDate && chunk.deadline) facts.push(`Due: ${formatDeadline(chunk.deadline)}`)
      if (facts.length === 0) {
        if (chunk.assignee) facts.push(`Owner: ${chunk.assignee}`)
        if (chunk.deadline) facts.push(`Due: ${formatDeadline(chunk.deadline)}`)
      }

      const factSuffix = facts.length > 0 ? ` ${facts.join('; ')}.` : ''
      const description = `${chunk.title}${chunk.content ? ` — ${chunk.content}` : ''}`.replace(
        /\.+$/,
        ''
      )
      return `- ${meeting.title}: ${description}.${factSuffix}`
    })

    return `I found this in the structured meeting notes:\n\n${lines.join('\n')}`
  }

  private async formatMultiMeetingSynthesisAnswer(
    selected: MeetingInventoryEntry[],
    question: string,
    summaryStats: { cacheHits: number; cacheMisses: number }
  ): Promise<string | null> {
    const sections: string[] = []
    let evidenceCount = 0

    for (const meeting of selected) {
      const beforeHits = this.getCacheHitCount()
      const summary = await this.loadMeetingSummary(meeting, 'search')
      if (this.getCacheHitCount() > beforeHits) {
        summaryStats.cacheHits += 1
      } else {
        summaryStats.cacheMisses += 1
      }

      const evidence = selectSynthesisEvidence(summary, question)
      if (evidence.length === 0) continue
      evidenceCount += evidence.length
      const dateStr = new Date(meeting.date).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
      sections.push(
        `From ${meeting.title} (${dateStr}):\n${evidence
          .map((chunk) => `- [${chunk.category}] ${formatEvidenceChunkForContext(chunk)}`)
          .join('\n')}`
      )
    }

    if (sections.length === 0) return null

    const prefix = `I found ${evidenceCount} relevant note${evidenceCount === 1 ? '' : 's'} across ${sections.length} meeting${sections.length === 1 ? '' : 's'}.`
    return `${prefix}\n\n${sections.join('\n\n')}`
  }

  private cacheHitCount = 0

  private getCacheHitCount(): number {
    return this.cacheHitCount
  }

  private async loadMeetingSummary(
    meeting: MeetingInventoryEntry,
    mode: SummaryMode
  ): Promise<MeetingSummary> {
    const signature = await this.getSummarySignature(meeting.dir, mode)
    const key = `${meeting.id}:${mode}`
    const cached = this.summaryCache.get(key)
    if (cached?.signature === signature) {
      this.cacheHitCount += 1
      return cached.summary
    }

    const summary = await loadMeetingSummaryFromDisk(meeting.dir, mode)
    this.summaryCache.set(key, { signature, summary })
    return summary
  }

  private async getSummarySignature(meetingDir: string, mode: SummaryMode): Promise<string> {
    const segmentsStat = await stat(join(meetingDir, 'segments.json')).catch(() => null)
    const transcriptStat =
      mode === 'full' ? await stat(join(meetingDir, 'transcript.json')).catch(() => null) : null
    return [
      segmentsStat ? `${segmentsStat.mtimeMs}:${segmentsStat.size}` : 'no-segments',
      transcriptStat ? `${transcriptStat.mtimeMs}:${transcriptStat.size}` : 'no-transcript'
    ].join('|')
  }

  private result(params: {
    intent: ChatIntent
    inventory: MeetingInventoryEntry[]
    directAnswer: string | null
    context: string
    matched: MeetingInventoryEntry[]
    selected: MeetingInventoryEntry[]
    matchMode: ChatRetrievalDiagnostics['matchMode']
    inventoryElapsedMs: number
    selectionElapsedMs: number
    summaryElapsedMs: number
    cacheHits: number
    cacheMisses: number
    clarificationOptions?: ChatClarificationOption[]
    candidateConfidence?: CandidateConfidence
  }): ChatRetrievalResult {
    return {
      directAnswer: params.directAnswer,
      context: params.context,
      clarificationOptions: params.clarificationOptions,
      diagnostics: {
        intent: params.intent,
        inventoryCount: params.inventory.length,
        matchedCount: params.matched.length,
        selectedContextCount: params.selected.length,
        matchMode: params.matchMode,
        matchedMeetingIds: params.matched.map((meeting) => meeting.id),
        matchedTitles: params.matched.map((meeting) => meeting.title),
        selectedMeetingIds: params.selected.map((meeting) => meeting.id),
        selectedTitles: params.selected.map((meeting) => meeting.title),
        inventoryElapsedMs: params.inventoryElapsedMs,
        selectionElapsedMs: params.selectionElapsedMs,
        summaryElapsedMs: params.summaryElapsedMs,
        cacheHits: params.cacheHits,
        cacheMisses: params.cacheMisses,
        promptChars: params.context.length,
        semanticEnabled: this.semanticDiagnostics.enabled,
        semanticCandidateCount: this.semanticDiagnostics.candidateCount,
        semanticElapsedMs: this.semanticDiagnostics.elapsedMs,
        embeddingCacheHits: this.semanticDiagnostics.embeddingCacheHits,
        embeddingCacheMisses: this.semanticDiagnostics.embeddingCacheMisses,
        candidateTopScore: params.candidateConfidence?.topScore,
        candidateSecondScore: params.candidateConfidence?.secondScore,
        candidateScoreGap: params.candidateConfidence?.scoreGap,
        candidateScoreRatio: params.candidateConfidence?.scoreRatio,
        clarificationReason: params.candidateConfidence?.reason
      }
    }
  }
}

async function loadMeetingSummaryFromDisk(
  meetingDir: string,
  mode: SummaryMode
): Promise<MeetingSummary> {
  try {
    const sPath = join(meetingDir, 'segments.json')
    const segments: MeetingSegments = (await isEncrypted(sPath))
      ? await decryptJSON<MeetingSegments>(sPath)
      : JSON.parse(await readFile(sPath, 'utf-8'))

    let body = ''
    let searchText = ''
    const snippets: string[] = []
    const notes: MeetingNoteItem[] = []
    const evidence: MeetingEvidenceChunk[] = []
    for (const [category, items] of Object.entries(segments)) {
      if (items.length === 0) continue
      body += `\n### ${category}\n`
      for (const [index, item] of items.entries()) {
        const fields = formatSegmentFields(item)
        body += `- **${item.title}**: ${item.content}${fields ? ` (${fields})` : ''}\n`
        const noteSearchText = buildNoteSearchText(item)
        searchText += ` ${noteSearchText}`
        snippets.push(`${item.title}: ${item.content}`)
        const note = {
          category: category as keyof MeetingSegments,
          title: item.title,
          content: item.content,
          topic: item.topic,
          assignee: item.assignee,
          deadline: item.deadline,
          searchText: noteSearchText
        }
        notes.push(note)
        evidence.push({
          id: item.id || `${category}-${index}`,
          source: 'note',
          category: category as keyof MeetingSegments,
          title: item.title,
          content: item.content,
          topic: item.topic,
          assignee: item.assignee,
          deadline: item.deadline,
          searchText: noteSearchText
        })
      }
    }

    if (body.trim()) {
      const transcriptEvidence =
        mode === 'full' ? await readTranscriptEvidence(meetingDir).catch(() => []) : []
      const transcriptText = transcriptEvidence.map((chunk) => chunk.content).join(' ')
      const transcriptExcerpt = formatTranscriptFallbackExcerpt(transcriptText, searchText)
      const fullBody = transcriptExcerpt
        ? `${body.trim()}\n\n### transcriptExcerpt\n${transcriptExcerpt}`
        : body.trim()
      const fullSearchText = transcriptExcerpt ? `${searchText} ${transcriptText}` : searchText
      const fullSnippets = transcriptExcerpt
        ? [...snippets, `Transcript excerpt: ${transcriptExcerpt}`]
        : snippets
      const fullEvidence = transcriptExcerpt ? [...evidence, ...transcriptEvidence] : evidence

      return {
        body: fullBody,
        searchText: fullSearchText,
        snippets: fullSnippets,
        notes,
        evidence: fullEvidence,
        hasNotes: true,
        source: 'segments'
      }
    }
  } catch {
    // Fall through to optional transcript fallback.
  }

  try {
    const transcriptEvidence = await readTranscriptEvidence(meetingDir)
    const text = transcriptEvidence.map((chunk) => chunk.content).join(' ')
    const body = mode === 'search' ? null : text.slice(0, 2000) + (text.length > 2000 ? '...' : '')
    return {
      body,
      searchText: text,
      snippets: text ? [text] : [],
      notes: [],
      evidence: transcriptEvidence,
      hasNotes: text.trim().length > 0,
      source: 'transcript'
    }
  } catch {
    return {
      body: null,
      searchText: '',
      snippets: [],
      notes: [],
      evidence: [],
      hasNotes: false,
      source: 'none'
    }
  }
}

async function readInventorySpeakerLabels(meetingDir: string): Promise<string[]> {
  try {
    const speakerPath = join(meetingDir, 'speakers.json')
    const speakers = (await readMaybeEncryptedJson<Record<string, { label?: string }>>(
      speakerPath
    )) as Record<string, { label?: string }>
    return Array.from(
      new Set(
        Object.values(speakers)
          .map((speaker) => speaker.label?.trim())
          .filter((label): label is string => Boolean(label && !/^speaker\s*\d*$/i.test(label)))
      )
    ).slice(0, 8)
  } catch {
    return []
  }
}

async function readInventoryNotePreview(meetingDir: string): Promise<string | null> {
  try {
    const segments = await readMaybeEncryptedJson<MeetingSegments>(
      join(meetingDir, 'segments.json')
    )
    const preview = Object.values(segments)
      .flat()
      .slice(0, 4)
      .map((segment) => `${segment.title}: ${segment.content}`)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return preview ? limitText(preview, 360) : null
  } catch {
    try {
      const transcript = await readMaybeEncryptedJson<Transcript[]>(
        join(meetingDir, 'transcript.json')
      )
      const preview = transcript
        .slice(0, 4)
        .map((segment) => segment.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      return preview ? limitText(preview, 240) : null
    } catch {
      return null
    }
  }
}

async function readInventoryTranscriptStatus(
  meetingDir: string
): Promise<MeetingInventoryEntry['transcriptStatus']> {
  if (
    await stat(join(meetingDir, 'segments.json'))
      .then(() => true)
      .catch(() => false)
  ) {
    return 'notes'
  }
  if (
    await stat(join(meetingDir, 'transcript.json'))
      .then(() => true)
      .catch(() => false)
  ) {
    return 'transcript'
  }
  if (
    await stat(join(meetingDir, 'transcript.error'))
      .then(() => true)
      .catch(() => false)
  ) {
    return 'failed'
  }
  return 'none'
}

async function readMaybeEncryptedJson<T>(targetPath: string): Promise<T> {
  return (await isEncrypted(targetPath))
    ? await decryptJSON<T>(targetPath)
    : JSON.parse(await readFile(targetPath, 'utf-8'))
}

async function readTranscriptEvidence(meetingDir: string): Promise<MeetingEvidenceChunk[]> {
  const tPath = join(meetingDir, 'transcript.json')
  const transcripts: Transcript[] = (await isEncrypted(tPath))
    ? await decryptJSON<Transcript[]>(tPath)
    : JSON.parse(await readFile(tPath, 'utf-8'))
  const chunks: MeetingEvidenceChunk[] = []
  let buffer: Transcript[] = []
  let bufferChars = 0

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer
      .map((item) => `${item.speaker}: ${item.text}`)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) {
      const first = buffer[0]
      const last = buffer[buffer.length - 1]
      chunks.push({
        id: `transcript-${first.startMs}-${last.endMs}`,
        source: 'transcript',
        category: 'transcript',
        title: `Transcript ${formatTranscriptTimestamp(first.startMs)}`,
        content: text,
        topic: null,
        assignee: null,
        deadline: null,
        searchText: text
      })
    }
    buffer = []
    bufferChars = 0
  }

  for (const transcript of transcripts) {
    const text = transcript.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (bufferChars + text.length > 1_200 && buffer.length > 0) flush()
    buffer.push(transcript)
    bufferChars += text.length
  }
  flush()

  return chunks
}

function formatTranscriptTimestamp(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function formatTranscriptFallbackExcerpt(transcriptText: string, noteSearchText: string): string {
  const cleaned = transcriptText.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''

  const normalizedTranscript = normalizeRecordingSearchText(cleaned)
  const normalizedNotes = normalizeRecordingSearchText(noteSearchText)
  if (
    normalizedTranscript.length > 0 &&
    normalizedNotes.length > 0 &&
    (normalizedNotes.includes(normalizedTranscript) ||
      normalizedTranscript.includes(normalizedNotes))
  ) {
    return ''
  }

  return cleaned.length > 2000 ? `${cleaned.slice(0, 2000).trim()}...` : cleaned
}

function buildNoteSearchText(item: Segment): string {
  return [item.topic, item.title, item.content, item.assignee, item.deadline, item.category]
    .filter(Boolean)
    .join(' ')
}

function formatSegmentFields(item: Segment): string {
  return [
    item.topic ? `Topic: ${item.topic}` : null,
    item.assignee ? `Owner: ${item.assignee}` : null,
    item.deadline ? `Due: ${item.deadline}` : null
  ]
    .filter(Boolean)
    .join('; ')
}

function buildRetrievalProfile(question: string): RetrievalProfile {
  const normalized = normalizeRecordingSearchText(question)
  return {
    wantsActions:
      /\b(action items?|actions?|tasks?|todos?|follow ups?|next steps?|assigned|owner|owns|complete|deliverables?)\b/.test(
        normalized
      ),
    wantsAssignees: /\b(who|assigned|owner|owns|responsible)\b/.test(normalized),
    wantsDeadlines: /\b(due|deadline|date|when)\b/.test(normalized),
    wantsDecisions: /\b(decisions?|decided|agree|agreed)\b/.test(normalized),
    wantsStatus: /\b(status|update|progress|blocked|blockers?|risk|risks?)\b/.test(normalized),
    wantsTopics: /\b(discuss|discussed|talk|talked|mention|mentioned|about|topic)\b/.test(
      normalized
    ),
    wantsThisWeek: /\bthis week\b/.test(normalized)
  }
}

function scoreMeetingForRetrieval(
  meeting: MeetingInventoryEntry,
  summary: MeetingSummary,
  question: string,
  profile: RetrievalProfile
): number {
  const subject = stripQuestionScaffolding(normalizeRecordingSearchText(question))
  const metadataText = meeting.metadataSearchText
  const summaryTextScore =
    subject && subjectTermCoverage(summary.searchText, subject) < 0.6
      ? 0
      : scoreTextRelevance(summary.searchText, subject || question)
  const titleScore =
    subject && subjectTermCoverage(meeting.title, subject) < 0.6
      ? 0
      : scoreTextRelevance(meeting.title, subject || question)
  const metadataScore =
    subject && subjectTermCoverage(metadataText, subject) < 0.5
      ? 0
      : scoreTextRelevance(metadataText, subject || question)
  const evidenceScore = summary.evidence
    .map((chunk) => scoreEvidenceChunkForRetrieval(chunk, question, profile))
    .sort((a, b) => b - a)
    .slice(0, 6)
    .reduce((total, score) => total + score, 0)

  return titleScore * 3 + metadataScore * 2 + summaryTextScore + evidenceScore
}

function scoreEvidenceChunkForRetrieval(
  chunk: MeetingEvidenceChunk,
  question: string,
  profile: RetrievalProfile
): number {
  const subject = stripQuestionScaffolding(normalizeRecordingSearchText(question))
  const baseQuestion = subject || question
  if (subject && subjectTermCoverage(chunk.searchText, subject) < 0.6) return 0
  let score = scoreTextRelevance(chunk.searchText, baseQuestion)

  if (subject && score === 0 && hasSpecificSubjectQuestion(question)) return 0
  if (!subject && score === 0 && isGeneralSummaryQuestion(question)) score = 1

  if (profile.wantsActions && chunk.category === 'actionItems') score += 10
  if (profile.wantsAssignees && chunk.assignee) score += 6
  if (profile.wantsDeadlines && chunk.deadline) score += 6
  if (profile.wantsDecisions && chunk.category === 'decisions') score += 8
  if (profile.wantsStatus && chunk.category === 'statusUpdates') score += 5
  if (profile.wantsStatus && /\b(risk|block|blocked|blocker)\b/.test(chunk.searchText)) score += 4
  if (profile.wantsTopics && chunk.category !== 'actionItems') score += 3
  if (profile.wantsThisWeek && isDeadlineThisWeek(chunk.deadline)) score += 6
  if (chunk.source === 'note') score += 2
  if (chunk.source === 'transcript' && score > 0) score -= 1

  return Math.max(0, score)
}

function subjectTermCoverage(text: string, subject: string): number {
  const normalizedText = normalizeRecordingSearchText(text)
  const terms = subject
    .split(' ')
    .filter((term) => term.length >= 3 && !QUESTION_STOP_WORDS.has(term))
  if (terms.length === 0) return 1
  if (terms.length > 1 && !hasSubjectPhraseOrProximity(normalizedText, terms)) {
    return 0
  }
  const matched = terms.filter((term) => normalizedText.includes(term)).length
  return matched / terms.length
}

function hasSubjectPhraseOrProximity(normalizedText: string, terms: string[]): boolean {
  const phrase = terms.join(' ')
  if (normalizedText.includes(phrase)) return true

  const words = normalizedText.split(' ')
  const positions = terms.map((term) =>
    words.reduce<number[]>((matches, word, index) => {
      if (word.includes(term)) matches.push(index)
      return matches
    }, [])
  )
  if (positions.some((matches) => matches.length === 0)) return false

  for (const firstPosition of positions[0]) {
    const allNearby = positions.every((matches) =>
      matches.some((position) => Math.abs(position - firstPosition) <= 6)
    )
    if (allNearby) return true
  }

  return false
}

function hasSpecificSubjectQuestion(question: string): boolean {
  return stripQuestionScaffolding(normalizeRecordingSearchText(question)).length > 0
}

function filterInventoryForDirectIntent(
  inventory: MeetingInventoryEntry[],
  question: string
): MeetingInventoryEntry[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  const subject = stripQuestionScaffolding(normalizedQuestion)
  const hasWindowConstraint = hasQuestionWindowCue(question)
  const hasMeetingTypeCue = hasExplicitMeetingTypeCue(question)
  const subjectTerms = extractQuestionTerms(subject)

  if (!hasWindowConstraint && !hasMeetingTypeCue && subjectTerms.length === 0) {
    return inventory
  }

  let filtered =
    hasWindowConstraint || hasMeetingTypeCue
      ? filterMeetingsForQuestionWindow(inventory, question)
      : inventory

  if (subjectTerms.length > 0) {
    filtered = filtered.filter((meeting) => {
      const searchableText = [
        meeting.title,
        meeting.calendarTitle,
        meeting.sourceName,
        meeting.sourceApp,
        meeting.slackChannel,
        meeting.notePreview,
        meeting.metadataSearchText,
        ...meeting.aliases,
        ...meeting.attendees,
        ...meeting.participants
      ]
        .filter(Boolean)
        .join(' ')
      return scoreTextRelevance(searchableText, subject) > 0
    })
  }

  return sortMeetingsByQuestion(filtered, question)
}

function isGeneralSummaryQuestion(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return /\b(summarize|summary|recap|what happened|what was discussed|what did we discuss|content)\b/.test(
    normalized
  )
}

// Generic verbs/qualifiers that carry no subject on their own, so a question
// built only from these + action vocabulary ("what do I NEED to follow up on?",
// "any OUTSTANDING action items?") is a generic "list my action items" request.
const GENERIC_FOLLOWUP_FILLER = new Set([
  'need',
  'needs',
  'want',
  'wants',
  'have',
  'outstanding',
  'open',
  'pending',
  'left',
  'remaining',
  'remember',
  'still',
  'address',
  'handle',
  'must'
])

const ACTION_ITEM_VOCABULARY = new Set([
  'action',
  'actions',
  'item',
  'items',
  'task',
  'tasks',
  'todo',
  'todos',
  'follow',
  'followup',
  'followups',
  'up',
  'step',
  'steps'
])

function isActionItemQuestion(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return /\b(action|actions|item|items|task|tasks|todo|todos|follow|steps)\b/.test(normalized)
}

function isStructuredActionFactQuestion(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return /\b(assigned|assignee|owner|owns|responsible|due|deadline)\b/.test(normalized)
}

function isMultiMeetingSynthesisQuestion(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return (
    /\b(compare|across|summarize|summary|recap|what was discussed|what did we discuss|what happened|content|themes?|topics?)\b/.test(
      normalized
    ) && /\b(meetings?|calls?|standups?|syncs?|huddles?|all|each|every|week)\b/.test(normalized)
  )
}

function isActionLikeEvidence(chunk: MeetingEvidenceChunk): boolean {
  return /\b(action|actions|item|items|task|tasks|todo|todos|follow up|next step|assigned|owner|due)\b/.test(
    chunk.searchText
  )
}

function selectSynthesisEvidence(
  summary: MeetingSummary,
  question: string
): MeetingEvidenceChunk[] {
  if (summary.evidence.length === 0) return []
  const profile = buildRetrievalProfile(question)
  const scored = summary.evidence
    .map((chunk) => ({
      chunk,
      score: scoreEvidenceChunkForRetrieval(chunk, question, profile)
    }))
    .sort((a, b) => b.score - a.score)

  const positive = scored
    .filter(({ score }) => score > 0)
    .slice(0, 4)
    .map(({ chunk }) => chunk)
  if (positive.length > 0) return positive

  return summary.evidence.filter((chunk) => chunk.source === 'note').slice(0, 4)
}

function createEmptySemanticDiagnostics(): SemanticRetrievalDiagnostics {
  return {
    enabled: false,
    candidateCount: 0,
    elapsedMs: 0,
    embeddingCacheHits: 0,
    embeddingCacheMisses: 0
  }
}

function selectSemanticCandidates(ranked: RankedMeetingSummary[]): RankedMeetingSummary[] {
  const selected = new Map<string, RankedMeetingSummary>()
  const add = (entry: RankedMeetingSummary): void => {
    if (entry.summary.evidence.length > 0) selected.set(entry.meeting.id, entry)
  }

  ranked
    .filter((entry) => entry.lexicalScore > 0)
    .slice(0, MAX_SEMANTIC_CANDIDATES)
    .forEach(add)

  ranked
    .slice()
    .sort((a, b) => b.meeting.date - a.meeting.date)
    .slice(0, Math.ceil(MAX_SEMANTIC_CANDIDATES / 3))
    .forEach(add)

  if (selected.size < MAX_SEMANTIC_CANDIDATES) {
    ranked.slice(0, MAX_SEMANTIC_CANDIDATES).forEach(add)
  }

  return Array.from(selected.values()).slice(0, MAX_SEMANTIC_CANDIDATES)
}

function hasStrongLexicalRetrievalSignal(
  ranked: RankedMeetingSummary[],
  question: string
): boolean {
  const top = ranked[0]
  if (!top || top.lexicalScore < 18) return false

  const subject = stripQuestionScaffolding(normalizeRecordingSearchText(question))
  const terms = subject
    .split(' ')
    .filter((term) => term.length >= 3 && !QUESTION_STOP_WORDS.has(term))
  if (terms.length < 2) return false

  const topText = `${top.meeting.title} ${top.summary.searchText}`
  if (subjectTermCoverage(topText, subject) < 0.6) return false

  const relevant = filterRelevantRankedMeetings(ranked)
  if (relevant.length <= MAX_CHAT_FULL_CONTEXT_MEETINGS) return true

  const secondScore = ranked[1]?.lexicalScore ?? 0
  return top.lexicalScore - secondScore >= 8
}

function buildQueryEmbeddingText(question: string): string {
  return `User meeting question: ${question}`
}

function buildChunkEmbeddingText(
  meeting: MeetingInventoryEntry,
  chunk: MeetingEvidenceChunk
): string {
  const fields = [
    `Meeting: ${meeting.title}`,
    meeting.calendarTitle ? `Calendar: ${meeting.calendarTitle}` : null,
    `Evidence type: ${chunk.category}`,
    chunk.topic ? `Topic: ${chunk.topic}` : null,
    chunk.assignee ? `Owner: ${chunk.assignee}` : null,
    chunk.deadline ? `Due: ${chunk.deadline}` : null,
    `Title: ${chunk.title}`,
    `Content: ${chunk.content}`
  ].filter(Boolean)

  return limitText(fields.join('\n'), MAX_EMBED_TEXT_CHARS)
}

function buildEmbeddingCacheKey(
  model: string,
  meetingId: string,
  chunk: MeetingEvidenceChunk,
  text: string
): string {
  return `${model}:${meetingId}:${chunk.id}:${hashText(text)}`
}

function buildQueryEmbeddingCacheKey(model: string, text: string): string {
  return `${model}:query:${hashText(text)}`
}

function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    aNorm += a[index] * a[index]
    bNorm += b[index] * b[index]
  }
  if (aNorm === 0 || bNorm === 0) return 0
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm))
}

function isValidEmbeddingCacheEntry(value: unknown): value is EmbeddingCacheEntry {
  if (value == null || typeof value !== 'object') return false
  const entry = value as Partial<EmbeddingCacheEntry>
  return (
    typeof entry.signature === 'string' &&
    typeof entry.lastUsedAt === 'number' &&
    Array.isArray(entry.vector) &&
    entry.vector.every((item) => typeof item === 'number')
  )
}

function semanticCategoryBoost(chunk: MeetingEvidenceChunk, question: string): number {
  const profile = buildRetrievalProfile(question)
  if (profile.wantsActions && chunk.category === 'actionItems') return 4
  if (profile.wantsDecisions && chunk.category === 'decisions') return 3
  if (profile.wantsStatus && chunk.category === 'statusUpdates') return 2
  return chunk.source === 'note' ? 1 : 0
}

function filterRelevantRankedMeetings(ranked: RankedMeetingSummary[]): RankedMeetingSummary[] {
  const scored = ranked.filter(({ score }) => score > 0)
  const topScore = scored[0]?.score ?? 0
  if (topScore === 0) return []

  const minimumScore = Math.max(4, Math.ceil(topScore * 0.35))
  return scored.filter(({ score }) => score >= minimumScore)
}

function evaluateCandidateConfidence(
  ranked: RankedMeetingSummary[],
  selected: MeetingInventoryEntry[],
  question: string
): CandidateConfidence {
  const selectedIds = new Set(selected.map((meeting) => meeting.id))
  const selectedRanked = ranked.filter((entry) => selectedIds.has(entry.meeting.id))
  const top = selectedRanked[0]
  const second = selectedRanked[1]
  const topScore = top?.score ?? 0
  const secondScore = second?.score ?? 0
  const scoreGap = Math.max(0, topScore - secondScore)
  const scoreRatio = topScore > 0 ? secondScore / topScore : 1

  if (selected.length === 0 || topScore <= 0) {
    return {
      shouldClarify: true,
      reason: 'no-match',
      topScore,
      secondScore,
      scoreGap,
      scoreRatio
    }
  }

  if (selectedRanked.length < 2) {
    return {
      shouldClarify: false,
      reason: 'none',
      topScore,
      secondScore,
      scoreGap,
      scoreRatio: 0
    }
  }

  const normalized = normalizeRecordingSearchText(question)
  const hasVagueMeetingCue =
    /\b(which meeting|what meeting|the meeting|a meeting|that meeting|cant remember|can't remember|do not remember|don't remember)\b/.test(
      normalized
    )
  const hasTypeOnlyCue =
    /\b(standup|stand up|huddle|call|sync|1 on 1|one on one|one-on-one)\b/.test(normalized) &&
    stripQuestionScaffolding(normalized).split(' ').filter(Boolean).length <= 4

  if ((hasVagueMeetingCue || hasTypeOnlyCue) && selectedRanked.length > 1) {
    return {
      shouldClarify: true,
      reason: 'ambiguous-metadata',
      topScore,
      secondScore,
      scoreGap,
      scoreRatio
    }
  }

  if (topScore < 8) {
    return {
      shouldClarify: true,
      reason: 'weak-top-score',
      topScore,
      secondScore,
      scoreGap,
      scoreRatio
    }
  }

  if (scoreRatio >= 0.82 || scoreGap <= 5) {
    return {
      shouldClarify: true,
      reason: 'close-score-spread',
      topScore,
      secondScore,
      scoreGap,
      scoreRatio
    }
  }

  return {
    shouldClarify: false,
    reason: 'none',
    topScore,
    secondScore,
    scoreGap,
    scoreRatio
  }
}

function limitMeetingBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length <= 6000) return trimmed
  return `${trimmed.slice(0, 6000).trim()}\n\n[Meeting notes truncated for prompt size.]`
}

function limitText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, maxChars).trim()
}

function formatRelevantNoteEvidence(summary: MeetingSummary, question: string): string {
  if (summary.evidence.length === 0) return ''

  const profile = buildRetrievalProfile(question)
  const scored = summary.evidence
    .map((chunk) => ({
      chunk,
      score: scoreEvidenceChunkForRetrieval(chunk, question, profile)
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_NOTE_EXCERPTS_PER_MEETING)

  if (scored.length === 0) return ''

  return scored
    .map(({ chunk }) => `- [${chunk.category}] ${formatEvidenceChunkForContext(chunk)}`)
    .join('\n')
}

function formatNoteForContext(note: MeetingNoteItem): string {
  const fields = [
    note.topic ? `Topic: ${note.topic}` : null,
    note.assignee ? `Owner: ${note.assignee}` : null,
    note.deadline ? `Due: ${note.deadline}` : null
  ]
    .filter(Boolean)
    .join('; ')
  return `${note.title}: ${note.content}${fields ? ` (${fields})` : ''}`
}

function formatEvidenceChunkForContext(chunk: MeetingEvidenceChunk): string {
  if (chunk.source === 'note') {
    return formatNoteForContext({
      category: chunk.category as keyof MeetingSegments,
      title: chunk.title,
      content: chunk.content,
      topic: chunk.topic,
      assignee: chunk.assignee,
      deadline: chunk.deadline,
      searchText: chunk.searchText
    })
  }
  return `${chunk.title}: ${chunk.content}`
}

function stripQuestionScaffolding(question: string): string {
  const extraStopWords = new Set([
    'action',
    'actions',
    'around',
    'assigned',
    'assignment',
    'assignee',
    'call',
    'calls',
    'came',
    'can',
    'cannot',
    'complete',
    'could',
    'date',
    'deadline',
    'decide',
    'decided',
    'decision',
    'decisions',
    'discuss',
    'discussed',
    'do',
    'due',
    'find',
    'huddle',
    'huddles',
    'item',
    'items',
    'last',
    'mention',
    'mentioned',
    'meeting',
    'one',
    'open',
    'out',
    'owner',
    'owners',
    'owns',
    'recording',
    'responsible',
    'remember',
    'say',
    'search',
    'should',
    'standup',
    'stand',
    'status',
    'sync',
    'task',
    'tasks',
    'think',
    'talk',
    'talked',
    'todo',
    't',
    'up',
    'use',
    'we',
    'were',
    'week',
    'weeks',
    'focus',
    'you',
    'yesterday'
  ])

  return question
    .split(' ')
    .filter((word) => !QUESTION_STOP_WORDS.has(word) && !extraStopWords.has(word))
    .join(' ')
}

function isDeadlineThisWeek(deadline: string | null): boolean {
  if (!deadline) return false
  const deadlineDate = new Date(deadline)
  if (Number.isNaN(deadlineDate.getTime())) return false

  const now = new Date()
  const startOfWeek = new Date(now)
  const day = startOfWeek.getDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  startOfWeek.setDate(startOfWeek.getDate() - diffToMonday)
  startOfWeek.setHours(0, 0, 0, 0)

  const endOfWeek = new Date(startOfWeek)
  endOfWeek.setDate(startOfWeek.getDate() + 7)
  return deadlineDate >= startOfWeek && deadlineDate < endOfWeek
}

function formatDeadline(deadline: string): string {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline)
  const parsed = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(deadline)
  if (Number.isNaN(parsed.getTime())) return deadline
  return parsed.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

function findBestCalendarRecordingMatches(
  events: CalendarEvent[],
  inventory: MeetingInventoryEntry[]
): Array<{ event: CalendarEvent; meeting: MeetingInventoryEntry | null; score: number }> {
  const usedMeetingIds = new Set<string>()
  return events.map((event) => {
    const scored = inventory
      .map((meeting) => ({
        meeting,
        score: scoreCalendarRecordingMatch(event, meeting)
      }))
      .filter(({ meeting, score }) => score >= 9 && !usedMeetingIds.has(meeting.id))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Math.abs(a.meeting.date - event.startTime) - Math.abs(b.meeting.date - event.startTime)
      )

    if (scored[0]) usedMeetingIds.add(scored[0].meeting.id)

    return {
      event,
      meeting: scored[0]?.meeting ?? null,
      score: scored[0]?.score ?? 0
    }
  })
}

function scoreCalendarRecordingMatch(event: CalendarEvent, meeting: MeetingInventoryEntry): number {
  const eventTitle = normalizeRecordingSearchText(event.title)
  const meetingTitle = normalizeRecordingSearchText(
    [meeting.title, meeting.calendarTitle, ...meeting.aliases].filter(Boolean).join(' ')
  )
  const eventDay = new Date(event.startTime).toDateString()
  const meetingDay = new Date(meeting.date).toDateString()
  if (eventDay !== meetingDay) return 0

  const timeDistanceMs = Math.abs(meeting.date - event.startTime)
  const startsDuringEvent = meeting.date >= event.startTime && meeting.date <= event.endTime
  const exactCalendarTitle =
    meeting.calendarTitle != null &&
    normalizeRecordingSearchText(meeting.calendarTitle) === eventTitle
  const titleCoverage = scoreCalendarTitleCoverage(eventTitle, meetingTitle)
  if (!exactCalendarTitle && titleCoverage < 0.5) return 0

  let score = 0
  score += 5
  if (startsDuringEvent) score += 8
  else if (timeDistanceMs <= 45 * 60 * 1000) score += 6
  else if (timeDistanceMs <= 3 * 60 * 60 * 1000) score += 2

  score += scoreTextRelevance(meetingTitle, eventTitle) * 2
  if (exactCalendarTitle) score += 8
  if (
    meeting.normalizedAliases.some((alias) => alias === eventTitle || alias.includes(eventTitle))
  ) {
    score += 5
  }

  return score
}

function scoreCalendarTitleCoverage(eventTitle: string, meetingTitle: string): number {
  const terms = eventTitle
    .split(' ')
    .filter((term) => term.length >= 3 && !QUESTION_STOP_WORDS.has(term))
  if (terms.length === 0) return 0

  const matched = terms.filter((term) => meetingTitle.includes(term)).length
  return matched / terms.length
}

function formatCalendarNoteAvailabilityAnswer(availability: CalendarNoteAvailability[]): string {
  if (availability.length === 0) return 'I do not have a previous meeting list to compare against.'

  const withNotes = availability.filter((item) => item.hasNotes && item.meeting)
  if (withNotes.length === 0) {
    return `I checked those ${availability.length} calendar meeting${availability.length === 1 ? '' : 's'}, but I did not find local notes for any of them.`
  }

  const lines = withNotes.map((item, index) => {
    const event = item.event
    const start = new Date(event.startTime)
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
    const title = item.meeting?.title ?? event.title
    return `${index + 1}. ${title} (${dateStr})`
  })

  const missingCount = availability.length - withNotes.length
  const missingSuffix =
    missingCount > 0
      ? `\n\nI did not find local notes for the other ${missingCount} calendar meeting${missingCount === 1 ? '' : 's'} in that list.`
      : ''

  return `Of those ${availability.length} calendar meeting${availability.length === 1 ? '' : 's'}, I found local notes for ${withNotes.length}:\n\n${lines.join('\n')}${missingSuffix}`
}

function materializeInventoryEntry(
  entry: RawInventoryEntry,
  recentEvents: CalendarEvent[]
): MeetingInventoryEntry {
  const startedAt = entry.metadata?.startedAt ?? entry.primaryBirthtime
  const matchedCalendarEvent = matchCalendarEvent(recentEvents, startedAt)
  const calendarTitle = matchedCalendarEvent?.title ?? entry.metadata?.calendarTitle ?? null
  const title = buildRecordingTitle(entry.metadata, startedAt, calendarTitle)
  const sourceName = entry.metadata?.sourceName ?? null
  const sourceApp = inferSourceApp(sourceName, title)
  const slackChannel = inferSlackChannel(`${sourceName ?? ''} ${title} ${calendarTitle ?? ''}`)
  const attendees = matchedCalendarEvent?.attendees ?? []
  const participants = Array.from(new Set([...entry.speakerLabels, ...attendees])).slice(0, 12)
  const aliases = buildRecordingTitleAliases({
    title,
    metadata: entry.metadata,
    calendarTitle,
    startedAt
  })
  const normalizedAliases = aliases
    .map(normalizeRecordingSearchText)
    .filter((alias) => alias.length >= 4)

  return {
    id: entry.id,
    date: startedAt,
    dir: entry.dir,
    title,
    calendarTitle,
    sourceName,
    sourceApp,
    slackChannel,
    attendees,
    participants,
    notePreview: entry.notePreview,
    transcriptStatus: entry.transcriptStatus,
    metadataSearchText: buildMeetingMetadataSearchText({
      title,
      calendarTitle,
      sourceName,
      sourceApp,
      slackChannel,
      participants,
      notePreview: entry.notePreview,
      transcriptStatus: entry.transcriptStatus
    }),
    aliases,
    normalizedAliases
  }
}

function buildCalendarSignature(events: CalendarEvent[]): string {
  if (events.length === 0) return 'none'
  return events
    .map(
      (event) =>
        `${event.id}:${event.title}:${event.startTime}:${event.endTime}:${event.attendees.join(',')}`
    )
    .join('|')
}

function buildMeetingMetadataSearchText(params: {
  title: string
  calendarTitle: string | null
  sourceName: string | null
  sourceApp: string | null
  slackChannel: string | null
  participants: string[]
  notePreview: string | null
  transcriptStatus: MeetingInventoryEntry['transcriptStatus']
}): string {
  return normalizeRecordingSearchText(
    [
      params.title,
      params.calendarTitle,
      params.sourceName,
      params.sourceApp,
      params.slackChannel ? `#${params.slackChannel} ${params.slackChannel}` : null,
      params.participants.join(' '),
      params.notePreview,
      params.transcriptStatus
    ]
      .filter(Boolean)
      .join(' ')
  )
}

function inferSourceApp(sourceName: string | null, title: string): string | null {
  const text = `${sourceName ?? ''} ${title}`.toLowerCase()
  if (text.includes('slack') || text.includes('huddle')) return 'Slack'
  if (text.includes('zoom')) return 'Zoom'
  if (text.includes('meet.google') || text.includes('google meet')) return 'Google Meet'
  if (text.includes('teams')) return 'Microsoft Teams'
  if (sourceName && sourceName !== 'Entire screen') return sourceName
  return null
}

function inferSlackChannel(text: string): string | null {
  const match = text.match(/#([a-z0-9][a-z0-9_-]{1,80})/i)
  return match?.[1] ?? null
}

function shouldAnswerExactSummaryDirectly(question: string): boolean {
  const normalized = normalizeRecordingSearchText(question)
  return /\b(summarize|summary|notes?|recap)\b/.test(normalized)
}

function formatOneSentenceSummary(summary: MeetingSummary): string {
  const snippet = summary.snippets[0] ?? summary.searchText
  const cleaned = snippet.replace(/\s+/g, ' ').trim()
  if (!cleaned) return 'No usable summary text is available.'
  const sentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? cleaned
  return sentence.length > 240 ? `${sentence.slice(0, 237).trim()}...` : sentence
}

function formatDirectSummaryBullets(summary: MeetingSummary): string {
  const snippets = summary.snippets.length > 0 ? summary.snippets : [summary.searchText]
  return snippets
    .map((snippet) => snippet.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((snippet) => `- ${snippet}`)
    .join('\n')
}

export function detectChatIntent(question: string): ChatIntent {
  const normalized = normalizeRecordingSearchText(question)
  const asksRecordings = /\brecordings?\b/.test(normalized)

  if (asksRecordings && /\b(how many|count|number of)\b/.test(normalized)) {
    return 'count'
  }

  if (
    asksRecordings &&
    /\b(list|show|what are|which are)\b/.test(normalized) &&
    !/\b(summarize|summary|notes?)\b/.test(normalized)
  ) {
    return 'list'
  }

  if (
    asksRecordings &&
    /\b(all|every|each)\b/.test(normalized) &&
    /\b(summarize|summary|notes?)\b/.test(normalized)
  ) {
    return 'summarize-all'
  }

  return 'broad'
}

// "what was my most recent recording about?" / "my latest recording" select the
// single newest recording. Ranked relevance retrieval ignores recency and was
// picking the wrong (often oldest) meeting, so this is handled deterministically
// against the inventory, which is ordered most-recent-first. A bare time window
// ("last week") is NOT a recency selector.
export function isLatestRecordingQuery(question: string): boolean {
  const n = normalizeRecordingSearchText(question)
  const recency = /\b(most recent|latest|newest|last)\b/.test(n)
  const recording = /\b(recording|recorded|record)\b/.test(n)
  const timeWindow = /\b(week|month|year|yesterday|today|day|quarter)\b/.test(n)
  return recency && recording && !timeWindow
}

function findExactTitleMatches(
  inventory: MeetingInventoryEntry[],
  question: string
): MeetingInventoryEntry[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (!normalizedQuestion) return []

  const matches = inventory
    .map((meeting) => {
      const bestAliasLength = meeting.normalizedAliases.reduce((best, alias) => {
        if (alias.length < 8) return best
        if (!normalizedQuestion.includes(alias) && !alias.includes(normalizedQuestion)) return best
        return Math.max(best, alias.length)
      }, 0)
      return { meeting, bestAliasLength }
    })
    .filter((match) => match.bestAliasLength > 0)

  const longestAliasLength = Math.max(0, ...matches.map((match) => match.bestAliasLength))
  return matches
    .filter((match) => match.bestAliasLength === longestAliasLength)
    .map((match) => match.meeting)
}

function formatRecordingListAnswer(inventory: MeetingInventoryEntry[]): string {
  if (inventory.length === 0) return 'You do not have any recordings yet.'

  const visible = inventory.slice(0, LIST_DIRECT_LIMIT)
  const lines = visible.map((meeting, index) => {
    const date = new Date(meeting.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
    return `${index + 1}. ${meeting.title} (${date})`
  })
  const suffix =
    inventory.length > visible.length
      ? `\n\nI found ${inventory.length} recordings total and showed the most recent ${visible.length}. Ask for a date range, title, or topic to narrow this down.`
      : `\n\nI found ${inventory.length} recording${inventory.length === 1 ? '' : 's'} total.`

  return `Here are your recordings:\n\n${lines.join('\n')}${suffix}`
}

function formatLargeAllGuardrailAnswer(inventory: MeetingInventoryEntry[]): string {
  const visible = inventory.slice(0, LIST_DIRECT_LIMIT)
  const lines = visible.map((meeting, index) => `${index + 1}. ${meeting.title}`)

  return `I found ${inventory.length} recordings. Summarizing all of them at once would be slow and may exceed the local AI context window.\n\nHere are the most recent ${visible.length}:\n${lines.join('\n')}\n\nAsk for a date range, title, or topic and I can summarize that smaller set.`
}

function formatMeetingClarification(
  question: string,
  selection: MeetingCandidateSelection
): { answer: string; options: ChatClarificationOption[] } | null {
  if (!shouldClarifyMeetingSelection(question)) return null

  const selectedRanked = selection.ranked.filter((entry) =>
    selection.selected.some((meeting) => meeting.id === entry.meeting.id)
  )

  if (selection.selected.length === 0 || selection.constrainedPoolCount === 0) {
    const windowText = selection.hasWindowConstraint ? ' in that time window' : ''
    return {
      answer: `I could not find a matching local recording${windowText}. What date, time frame, title, person, or topic should I search for?`,
      options: []
    }
  }

  if (selectedRanked.length < 2) return null

  if (!selection.confidence.shouldClarify) return null

  const options = selectedRanked.slice(0, 4).map((entry, index) => {
    return `${index + 1}. ${formatMeetingOption(entry.meeting)}`
  })

  return {
    answer: `I found a few possible matching meetings. Which one should I use?\n\n${options.join('\n')}\n\nIf none of these are right, tell me the date, time frame, title, person, or topic to search for.`,
    options: selectedRanked.slice(0, 4).map((entry) => formatClarificationOption(entry))
  }
}

function shouldClarifyMeetingSelection(question: string): boolean {
  if (isActionItemQuestion(question) || isStructuredActionFactQuestion(question)) return false

  const normalized = normalizeRecordingSearchText(question)
  if (
    /\b(all|every|each|meetings from|this weeks meetings|last weeks meetings)\b/.test(normalized)
  ) {
    return false
  }

  return (
    /\b(which meeting|what meeting|the meeting|a meeting|that meeting|standup|stand up|huddle|call|sync|1 on 1|one on one|one-on-one|cant remember|can't remember|do not remember|don't remember)\b/.test(
      normalized
    ) ||
    (hasQuestionWindowCue(question) &&
      /\b(summarize|summary|recap|talked|discussed)\b/.test(normalized))
  )
}

function shouldAnswerResolvedSummaryDirectly(
  question: string,
  selection: MeetingCandidateSelection
): boolean {
  return (
    selection.selected.length === 1 &&
    isGeneralSummaryQuestion(question) &&
    shouldClarifyMeetingSelection(question)
  )
}

function formatMeetingOption(meeting: MeetingInventoryEntry): string {
  const date = new Date(meeting.date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${meeting.title} (${date})`
}

function formatClarificationOption(entry: RankedMeetingSummary): ChatClarificationOption {
  const meeting = entry.meeting
  const date = new Date(meeting.date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  const details = [
    date,
    meeting.slackChannel ? `#${meeting.slackChannel}` : null,
    meeting.sourceApp,
    meeting.participants.length > 0 ? meeting.participants.slice(0, 3).join(', ') : null
  ].filter(Boolean)

  return {
    meetingId: meeting.id,
    title: meeting.title,
    subtitle: details.join(' · '),
    date: meeting.date,
    sourceName: meeting.sourceName,
    calendarTitle: meeting.calendarTitle,
    slackChannel: meeting.slackChannel,
    participants: meeting.participants,
    notePreview: meeting.notePreview,
    score: entry.score
  }
}

function formatMeetingMetadataForContext(meeting: MeetingInventoryEntry): string {
  const lines = [
    meeting.sourceName ? `Source: ${meeting.sourceName}` : null,
    meeting.sourceApp ? `App: ${meeting.sourceApp}` : null,
    meeting.slackChannel ? `Slack channel: #${meeting.slackChannel}` : null,
    meeting.participants.length > 0
      ? `Participants/attendees: ${meeting.participants.slice(0, 10).join(', ')}`
      : null,
    meeting.notePreview ? `Inventory note preview: ${meeting.notePreview}` : null,
    `Local data status: ${meeting.transcriptStatus}`
  ].filter(Boolean)
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function filterMeetingsForQuestionWindow<T extends { date: number }>(
  meetings: T[],
  question: string
): T[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (!normalizedQuestion) return meetings

  let filtered = meetings
  const now = new Date()
  if (normalizedQuestion.includes('today')) {
    const today = now.toDateString()
    filtered = filtered.filter((meeting) => new Date(meeting.date).toDateString() === today)
  }

  if (normalizedQuestion.includes('yesterday')) {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const yesterdayKey = yesterday.toDateString()
    filtered = filtered.filter((meeting) => new Date(meeting.date).toDateString() === yesterdayKey)
  }

  if (hasThisWeekCue(normalizedQuestion)) {
    const startOfWeek = new Date(now)
    const day = startOfWeek.getDay()
    const diffToMonday = day === 0 ? 6 : day - 1
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday)
    startOfWeek.setHours(0, 0, 0, 0)
    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 7)
    filtered = filtered.filter(
      (meeting) => meeting.date >= startOfWeek.getTime() && meeting.date < endOfWeek.getTime()
    )
  }

  if (hasThisMonthCue(normalizedQuestion)) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    filtered = filtered.filter(
      (meeting) => meeting.date >= startOfMonth.getTime() && meeting.date < endOfMonth.getTime()
    )
  }

  if (normalizedQuestion.includes('last week')) {
    const startOfWeek = new Date(now)
    const day = startOfWeek.getDay()
    const diffToMonday = day === 0 ? 6 : day - 1
    startOfWeek.setDate(startOfWeek.getDate() - diffToMonday - 7)
    startOfWeek.setHours(0, 0, 0, 0)
    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 7)
    filtered = filtered.filter(
      (meeting) => meeting.date >= startOfWeek.getTime() && meeting.date < endOfWeek.getTime()
    )
  }

  if (normalizedQuestion.includes('last month')) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    filtered = filtered.filter(
      (meeting) => meeting.date >= startOfMonth.getTime() && meeting.date < endOfMonth.getTime()
    )
  }

  if (/\b(standup|stand up)\b/.test(normalizedQuestion)) {
    filtered = filtered.filter((meeting) => {
      const text = meetingSearchTextForTypeFilter(meeting)
      return text.includes('stand') || text.includes('huddle')
    })
  }

  if (/\bhuddle\b/.test(normalizedQuestion)) {
    filtered = filtered.filter((meeting) =>
      meetingSearchTextForTypeFilter(meeting).includes('huddle')
    )
  }

  return filtered
}

function meetingSearchTextForTypeFilter<T extends { date: number }>(meeting: T): string {
  const fields: string[] = []
  if ('title' in meeting && meeting.title) fields.push(String(meeting.title))
  if ('aliases' in meeting && Array.isArray(meeting.aliases)) {
    fields.push(...meeting.aliases.map((alias) => String(alias)))
  }
  if ('sourceName' in meeting && meeting.sourceName) fields.push(String(meeting.sourceName))
  if ('calendarTitle' in meeting && meeting.calendarTitle)
    fields.push(String(meeting.calendarTitle))
  return normalizeRecordingSearchText(fields.join(' '))
}

function hasExplicitMeetingTypeCue(question: string): boolean {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  return /\b(standup|stand up|huddle|1 on 1|one on one|one-on-one)\b/.test(normalizedQuestion)
}

function hasQuestionWindowCue(question: string): boolean {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  return (
    normalizedQuestion.includes('today') ||
    normalizedQuestion.includes('yesterday') ||
    normalizedQuestion.includes('last week') ||
    normalizedQuestion.includes('last month') ||
    hasThisWeekCue(normalizedQuestion) ||
    hasThisMonthCue(normalizedQuestion)
  )
}

function hasThisWeekCue(normalizedQuestion: string): boolean {
  return /\bthis weeks?\b|\bthis week s\b/.test(normalizedQuestion)
}

function hasThisMonthCue(normalizedQuestion: string): boolean {
  return /\bthis months?\b/.test(normalizedQuestion)
}

function extractQuestionPhrases(question: string): string[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (!normalizedQuestion) return []

  const words = normalizedQuestion.split(' ').filter(Boolean)
  const phrases = new Set<string>()

  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`
    if (phrase.length < 6) continue
    if (QUESTION_STOP_WORDS.has(words[i]) && QUESTION_STOP_WORDS.has(words[i + 1])) continue
    phrases.add(phrase)
  }

  if (normalizedQuestion.includes('standup')) {
    phrases.add('standup')
  }

  return [...phrases]
}

export function extractQuestionTerms(question: string): string[] {
  const normalizedQuestion = normalizeRecordingSearchText(question)
  if (!normalizedQuestion) return []

  return [
    ...new Set(
      normalizedQuestion
        .split(' ')
        .filter((term) => term.length >= 3 && !QUESTION_STOP_WORDS.has(term))
    )
  ]
}

export function scoreTextRelevance(text: string, question: string): number {
  const normalizedText = normalizeRecordingSearchText(text)
  if (!normalizedText) return 0

  const terms = extractQuestionTerms(question)
  const phrases = extractQuestionPhrases(question)
  let score = 0

  for (const phrase of phrases) {
    if (normalizedText.includes(phrase)) score += 5
  }

  for (const term of terms) {
    if (normalizedText.includes(term)) score += 2
  }

  return score
}

export function scoreMeetingRelevance(title: string, question: string, content = ''): number {
  return scoreTextRelevance(title, question) * 4 + scoreTextRelevance(content, question)
}

export function sortMeetingsByQuestion<
  T extends { title: string; date: number; searchText?: string | null }
>(meetings: T[], question: string): T[] {
  return [...meetings].sort((a, b) => {
    const aScore = scoreMeetingRelevance(a.title, question, a.searchText ?? '')
    const bScore = scoreMeetingRelevance(b.title, question, b.searchText ?? '')
    if (aScore !== bScore) return bScore - aScore
    return b.date - a.date
  })
}
