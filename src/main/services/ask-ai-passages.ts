import {
  normalizeDuplicateEvidence,
  reserveAskAiTopMatch,
  useAskAiTopMatch
} from './ask-ai-top-match'
import { createHash } from 'crypto'
import { useAskAiAppendFollowups } from './ask-ai-writer-session'
import { mkdir, stat } from 'fs/promises'
import type { AskAiPrepareResult } from './ask-ai-index-prewarm'
import { dirname } from 'path'
import { decryptJSON, encryptJSON } from './crypto'
import { readAskAiCache, writeAskAiCache } from './ask-ai-cache-reader'
import type { ChatEmbeddingProvider } from './chat-retrieval'
import { filterMeetingsForQuestionWindow } from './chat-retrieval'
import { unicodeContentTokens } from './unicode-text'
import type { IndexedMeeting } from './meeting-index'
import type { AskAiAnswer } from './ask-ai-answer'
import { logAutodocEvent } from './autodoc-log'
import { numberSourceCards } from './ask-ai-citations'
import { evidenceTerms, questionFacet, matchesEvidenceFacet } from './ask-ai-evidence'
import { wantsDetailedAskAiAnswer } from './ask-ai-policy'
import {
  conversationSearchText,
  conversationTitleAnchors,
  conversationTokens,
  type AskAiConversationTurn
} from './ask-ai-conversation'

/** Index what fits in a writer excerpt, so semantic matches are not clipped away later. */
export function writerSizedPassages(text: string): string[] {
  let sentences: string[]
  try {
    sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)]
      .map((part) => part.segment.trim())
      .filter(Boolean)
  } catch {
    sentences = [text]
  }
  const units: string[] = []
  for (const sentence of sentences) {
    if (conversationTokens(sentence) <= 180) {
      units.push(sentence)
      continue
    }
    const chars = [...sentence]
    let at = 0
    while (at < chars.length) {
      let end = at,
        used = 0
      while (end < chars.length) {
        const cost = chars[end].codePointAt(0)! < 128 ? 1 / 3 : 2
        if (used + cost > 180) break
        used += cost
        end++
      }
      units.push(chars.slice(at, end).join('').trim())
      if (end >= chars.length) break
      let next = end,
        overlap = 0
      while (next > at + 1) {
        const cost = chars[next - 1].codePointAt(0)! < 128 ? 1 / 3 : 2
        if (overlap + cost > 40) break
        overlap += cost
        next--
      }
      at = Math.max(at + 1, next)
    }
  }
  const output: string[] = []
  let pending: string[] = []
  for (const unit of units) {
    if (pending.length && conversationTokens([...pending, unit].join(' ')) > 180) {
      output.push(pending.join(' '))
      const neighbour = pending.at(-1)!
      pending =
        conversationTokens(neighbour + ' ' + unit) <= 180 && conversationTokens(neighbour) <= 40
          ? [neighbour]
          : []
    }
    pending.push(unit)
  }
  if (pending.length) output.push(pending.join(' '))
  return output.filter(Boolean)
}

interface Passage {
  key: string
  meetingId: string
  title: string
  date: number
  kind: 'note' | 'transcript'
  text: string
  startMs: number | null
}
interface VectorCache {
  version: string
  rows: Array<[string, number[]]>
  coveredMeetingIds?: string[]
}

/** Full-coverage local retrieval, with encrypted derived vectors and lexical busy fallback. */
export class AskAiPassages {
  private vectors = new Map<string, number[] | Float64Array>()
  onIdentityInvalidated?: () => void
  private loaded = false
  private coveredMeetingIds = new Set<string>()
  private coverageNeedsSave = false
  private cacheLoad: Promise<void> | null = null
  private passageCache = new Map<string, { signature: string; title: string; rows: Passage[] }>()
  private indexing: Promise<AskAiPrepareResult> | null = null
  private controlVectors: Array<{ kind: string; vector: number[] }> = []
  private queryVectors = new Map<string, number[]>()
  private version: string
  constructor(
    private provider: ChatEmbeddingProvider,
    private cachePath: string
  ) {
    this.version = `passages-v2:${provider.model}:writer180-overlap40:dim${process.env.AUTODOC_ASK_AI_VECTOR_DIM || 'full'}`
  }

  private textInput(text: string, query: boolean): string {
    if (this.provider.model.startsWith('embeddinggemma-2')) {
      return query
        ? `task: search result | query: ${text}`
        : `title: ${text.split('\n')[0]} | text: ${text.split('\n').slice(1).join('\n')}`
    }
    return query
      ? `Instruct: Retrieve meeting passages that answer the question.\nQuery: ${text}`
      : text
  }

  private normalize(vector: number[]): number[] {
    const limit = Number(process.env.AUTODOC_ASK_AI_VECTOR_DIM) || vector.length
    const values = vector.slice(0, limit)
    if (!values.length || values.some((v) => !Number.isFinite(v)))
      throw Error('Invalid passage embedding')
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0))
    if (!Number.isFinite(norm) || norm === 0) throw Error('Zero passage embedding')
    return values.map((v) => v / norm)
  }

  private passages(meetings: IndexedMeeting[]): Passage[] {
    const output: Passage[] = []
    for (const meeting of meetings) {
      const cached = this.passageCache.get(meeting.meetingId)
      if (cached?.signature === meeting.signature && cached.title === meeting.title) {
        output.push(...cached.rows)
        continue
      }
      const start = output.length
      const seen = new Set<string>()
      const add = (text: string, kind: Passage['kind'], startMs: number | null): void => {
        for (const body of writerSizedPassages(text)) {
          if (!body || seen.has(body)) continue
          seen.add(body)
          const key = createHash('sha256')
            .update(
              `${this.version}\0${meeting.meetingId}\0${meeting.title}\0${kind}\0${startMs}\0${body}`
            )
            .digest('hex')
          output.push({
            key,
            meetingId: meeting.meetingId,
            title: meeting.title,
            date: meeting.date,
            kind,
            text: body,
            startMs
          })
        }
      }
      for (const entry of meeting.noteEntries)
        add(
          [
            entry.title,
            entry.topic,
            entry.content,
            entry.owner && `Owner: ${entry.owner}`,
            entry.deadline && `Due: ${entry.deadline}`
          ]
            .filter(Boolean)
            .join(' · '),
          'note',
          entry.sources[0]?.startMs ?? null
        )
      if (process.env.AUTODOC_ASK_AI_PASSAGES !== 'notes' || !meeting.noteEntries.length) {
        for (const chunk of meeting.transcriptChunks) add(chunk.text, 'transcript', chunk.startMs)
      }
      this.passageCache.set(meeting.meetingId, {
        signature: meeting.signature,
        title: meeting.title,
        rows: output.slice(start)
      })
    }
    return output
  }

  get isPreparing(): boolean {
    return this.indexing !== null
  }

  private selectProviderVersion(): void {
    const version = `passages-v2:${this.provider.cacheIdentity ?? this.provider.model}:writer180-overlap40:dim${process.env.AUTODOC_ASK_AI_VECTOR_DIM || 'full'}`
    if (version !== this.version) {
      this.version = version
      this.loaded = false
      this.vectors.clear()
      this.passageCache.clear()
      this.coveredMeetingIds.clear()
      this.coverageNeedsSave = false
      this.controlVectors = []
      this.queryVectors.clear()
    }
  }

  private async loadSavedCache(allowUnknownIdentity = false, offThread = false): Promise<void> {
    if (this.loaded) return
    if (this.cacheLoad) return this.cacheLoad
    const load = async (): Promise<void> => {
      try {
        const cache = offThread
          ? await readAskAiCache(this.cachePath)
          : await decryptJSON<VectorCache>(this.cachePath)
        // At launch the provider digest may not yet be known. Accept a saved
        // cache for this model/dimension; prepare verifies its installed digest.
        const prefix = `passages-v2:${this.provider.model}`
        const suffix = `:writer180-overlap40:dim${process.env.AUTODOC_ASK_AI_VECTOR_DIM || 'full'}`
        if (
          cache.version === this.version ||
          (allowUnknownIdentity &&
            this.version === prefix + suffix &&
            cache.version.startsWith(prefix + ':') &&
            cache.version.endsWith(suffix))
        ) {
          this.version = cache.version
          if ('rows' in cache)
            for (const [key, vector] of cache.rows) this.vectors.set(key, this.normalize(vector))
          else
            cache.keys.forEach((key, i) =>
              this.vectors.set(key, cache.values.subarray(cache.offsets[i], cache.offsets[i + 1]))
            )
          this.coveredMeetingIds = new Set(cache.coveredMeetingIds ?? [])
          this.coverageNeedsSave = cache.coveredMeetingIds === undefined
        }
      } catch {
        /* Missing or invalid derived cache is rebuilt from source. */
      }
      this.loaded = true
    }
    this.cacheLoad = load().finally(() => {
      this.cacheLoad = null
    })
    return this.cacheLoad
  }

  private markCovered(passages: Passage[]): void {
    // A recording with no passages has no indexed notes yet. Its first notes
    // are new content, rather than an edit to previously indexed evidence.
    const next = new Set(passages.map((p) => p.meetingId))
    if (
      next.size !== this.coveredMeetingIds.size ||
      [...next].some((id) => !this.coveredMeetingIds.has(id))
    )
      this.coverageNeedsSave = true
    this.coveredMeetingIds = next
  }

  async inspect(meetings: IndexedMeeting[]): Promise<{
    completed: number
    total: number
    semanticReady: boolean
    unavailable: boolean
    needsSave: boolean
  }> {
    // Inspection must not join Ollama startup. Known identities can be checked
    // now; unknown identities are revalidated before cached semantic retrieval.
    const unavailable =
      process.env.AUTODOC_ASK_AI_EMBEDDINGS === '0' ||
      ['missing', 'disabled'].includes(this.provider.availabilityReason ?? '')
    if (this.provider.cacheIdentity && !this.provider.cacheIdentity.endsWith(':unknown'))
      this.selectProviderVersion()
    await this.loadSavedCache(true, true)
    const passages: Passage[] = []
    for (const meeting of meetings) {
      passages.push(...this.passages([meeting]))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const completed = passages.filter((p) => this.vectors.has(p.key)).length
    if (completed === passages.length) {
      this.markCovered(passages)
      // Persistence belongs to prepare(), after inference gates open.
    }
    const semanticReady =
      completed === passages.length ||
      (this.coveredMeetingIds.size > 0 &&
        completed > 0 &&
        passages.every((p) => this.vectors.has(p.key) || !this.coveredMeetingIds.has(p.meetingId)))
    return {
      completed,
      total: passages.length,
      semanticReady: !unavailable && semanticReady,
      unavailable,
      needsSave: this.coverageNeedsSave
    }
  }

  private cacheData(): VectorCache {
    return {
      version: this.version,
      rows: [...this.vectors].map(([key, vector]) => [
        key,
        Array.isArray(vector) ? vector : Array.from(vector)
      ]),
      coveredMeetingIds: [...this.coveredMeetingIds]
    }
  }

  private async checkpoint(reason: 'periodic' | 'pause' | 'complete'): Promise<void> {
    const started = Date.now()
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeAskAiCache(this.cachePath, this.version, this.vectors, [...this.coveredMeetingIds])
    this.coverageNeedsSave = false
    logAutodocEvent({
      area: 'chat',
      message: 'Ask AI index checkpoint written',
      context: {
        reason,
        vectors: this.vectors.size,
        elapsedMs: Date.now() - started,
        bytes: (await stat(this.cachePath)).size
      }
    })
  }

  async prepare(
    meetings: IndexedMeeting[],
    canInfer: () => boolean | Promise<boolean> = () => true,
    options: {
      signal?: AbortSignal
      batchSize?: number
      onProgress?: (done: number, total: number, added: number) => void
      checkpoint?: boolean
    } = {}
  ): Promise<AskAiPrepareResult> {
    if (!(await canInfer())) return 'paused'
    while (this.indexing) await this.indexing
    const work = async (): Promise<AskAiPrepareResult> => {
      if (!(await canInfer())) return 'paused'
      if (!(await this.provider.isAvailable())) {
        if (options.checkpoint && this.provider.availabilityReason === 'unreachable')
          throw new Error('Embedding availability probe temporarily unreachable')
        return 'unavailable'
      }
      this.selectProviderVersion()
      await this.loadSavedCache()
      if (process.env.AUTODOC_ASK_AI_INTENTS === 'semantic' && this.controlVectors.length === 0) {
        if (!(await canInfer())) return 'paused'
        const examples = [
          { kind: 'count', text: 'How many recorded meetings do I have in total?' },
          { kind: 'count', text: 'What is the total number of audio recordings in my library?' },
          { kind: 'list', text: 'List my saved recordings.' },
          { kind: 'list', text: 'Show my recent recorded meetings.' },
          { kind: 'greeting', text: 'Hello! Good morning! Hi there!' },
          { kind: 'content', text: 'Who is responsible for the Atlas migration?' },
          { kind: 'content', text: 'How much money was set aside for the launch?' },
          { kind: 'content', text: 'How many replicas does the Harbor service have?' },
          { kind: 'content', text: 'How many decisions were made in the Atlas meeting?' },
          { kind: 'content', text: 'How many meetings discussed the Atlas budget yesterday?' },
          { kind: 'content', text: 'What is the recovery code in my meeting notes?' }
        ]
        const raw = await this.provider.embed(
          examples.map((e) => this.textInput(`Meeting question\n${e.text}`, false))
        )
        this.controlVectors = examples.map((e, i) => ({
          kind: e.kind,
          vector: this.normalize(raw[i])
        }))
      }
      const passages = this.passages(meetings)
      const missing = passages.filter((p) => !this.vectors.has(p.key))
      const batchSize = options.batchSize ?? 16
      let added = 0,
        checkpointAt = 0
      let finished = false
      options.onProgress?.(passages.length - missing.length, passages.length, 0)
      try {
        for (let at = 0; at < missing.length; at += batchSize) {
          options.signal?.throwIfAborted()
          if (!(await canInfer())) return 'paused'
          const batch = missing.slice(at, at + batchSize)
          const texts = batch.map((p) => this.textInput(`${p.title}\n${p.text}`, false))
          const embeddings = await (options.signal
            ? this.provider.embed(texts, options.signal)
            : this.provider.embed(texts))
          options.signal?.throwIfAborted()
          batch.forEach((p, i) => this.vectors.set(p.key, this.normalize(embeddings[i])))
          added += batch.length
          options.onProgress?.(passages.length - missing.length + added, passages.length, added)
          if (options.checkpoint && added - checkpointAt >= 512) {
            await this.checkpoint('periodic')
            checkpointAt = added
          }
        }
        options.signal?.throwIfAborted()
        if (options.checkpoint && !(await canInfer())) return 'paused'
        const current = new Set(passages.map((p) => p.key))
        let removed = false
        const currentMeetings = new Set(meetings.map((m) => m.meetingId))
        for (const id of this.passageCache.keys())
          if (!currentMeetings.has(id)) this.passageCache.delete(id)
        for (const key of this.vectors.keys())
          if (!current.has(key)) {
            this.vectors.delete(key)
            removed = true
          }
        this.markCovered(passages)
        if (missing.length || removed || (options.checkpoint && this.coverageNeedsSave)) {
          if (options.checkpoint) await this.checkpoint('complete')
          else {
            await mkdir(dirname(this.cachePath), { recursive: true })
            await encryptJSON(
              { version: this.version, rows: this.cacheData().rows },
              this.cachePath
            )
          }
        }
        finished = true
        return 'ready'
      } finally {
        if (!finished && options.checkpoint && added > checkpointAt) {
          // A failed best-effort pause write must not hide the original failure.
          try {
            await this.checkpoint('pause')
          } catch {
            /* retry on the next real trigger */
          }
        }
      }
    }
    this.indexing = work()
    try {
      return await this.indexing
    } finally {
      this.indexing = null
    }
  }

  private async semanticAvailable(cachedOnly: boolean): Promise<boolean> {
    if (!(await this.provider.isAvailable())) return false
    if (cachedOnly) {
      const before = this.version
      this.selectProviderVersion()
      if (this.version !== before) {
        await this.loadSavedCache(false, true)
        this.onIdentityInvalidated?.()
      }
      return this.vectors.size > 0
    }
    return true
  }

  private async queryVector(question: string): Promise<number[]> {
    const cached = this.queryVectors.get(question)
    if (cached) return cached
    const [raw] = await this.provider.embed([this.textInput(question, true)])
    const vector = this.normalize(raw)
    this.queryVectors.set(question, vector)
    if (this.queryVectors.size > 64)
      this.queryVectors.delete(this.queryVectors.keys().next().value!)
    return vector
  }

  async classifyControl(
    question: string,
    meetings: IndexedMeeting[],
    cachedOnly = false
  ): Promise<string | null> {
    if (process.env.AUTODOC_ASK_AI_INTENTS !== 'semantic') return null
    if (!cachedOnly) await this.prepare(meetings)
    if (cachedOnly && !(await this.semanticAvailable(true))) return null
    if (!this.controlVectors.length) return null
    const query = await this.queryVector(question)
    const scores = new Map<string, number>()
    for (const row of this.controlVectors) {
      const score = query.reduce((sum, v, i) => sum + v * row.vector[i], 0)
      scores.set(row.kind, Math.max(scores.get(row.kind) ?? -1, score))
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1])
    const [kind, score] = ranked[0]
    const margin = score - (ranked[1]?.[1] ?? 0)
    const accepted = kind !== 'content' && score >= 0.6 && margin >= 0.07
    logAutodocEvent({
      area: 'chat',
      message: 'experimental semantic intent decision',
      context: { kind, score, margin, accepted }
    })
    return accepted
      ? kind
      : (kind === 'count' || kind === 'list') && score >= 0.55
        ? 'planner'
        : null
  }

  /** General contextual retrieval. Prior scope is a ranking hint, never a gate. */
  async retrieveConversation(
    question: string,
    meetings: IndexedMeeting[],
    history: AskAiConversationTurn[],
    priorIds: string[] = [],
    scopedIds?: string[],
    signal?: AbortSignal,
    canInfer: () => boolean = () => true,
    carriedIds: string[] = [],
    onRanked?: (meetingIds: string[]) => void,
    cachedOnly = false
  ): Promise<AskAiAnswer | null> {
    signal?.throwIfAborted()
    const scoped = scopedIds?.length
      ? meetings.filter((meeting) => scopedIds.includes(meeting.meetingId))
      : filterMeetingsForQuestionWindow(meetings, question)
    let passages = this.passages(scoped)
    if (!passages.length) return null
    const contextual = history.length ? conversationSearchText(question, history) : question
    const terms = [...new Set(unicodeContentTokens(question, 2))]
    const contextTerms = [...new Set(unicodeContentTokens(contextual, 2))]
    const documents = new Map<string, number>()
    const queryTerms = new Set(terms)
    const queryMeetings = new Map<string, Set<string>>()
    for (const passage of passages)
      for (const term of new Set(unicodeContentTokens(`${passage.title} ${passage.text}`, 2))) {
        documents.set(term, (documents.get(term) ?? 0) + 1)
        if (!queryTerms.has(term)) continue
        const ids = queryMeetings.get(term) ?? new Set<string>()
        ids.add(passage.meetingId)
        queryMeetings.set(term, ids)
      }
    const lexical = (text: string, words: string[]): number => {
      const present = new Set(unicodeContentTokens(text, 2))
      return words.reduce(
        (score, term) =>
          score +
          (present.has(term) ? Math.log(1 + passages.length / (documents.get(term) ?? 1)) : 0),
        0
      )
    }
    // Names come from the actual library, rather than a vocabulary of questions.
    const named = conversationTitleAnchors(question, scoped)
    let vectors: number[][] = []
    if (canInfer()) {
      if (!cachedOnly) await this.prepare(meetings, canInfer)
      passages = this.passages(scoped)
      if (canInfer() && (await this.semanticAvailable(cachedOnly))) {
        const queries = history.length ? [question, contextual] : [question]
        const missing = queries.filter((query) => !this.queryVectors.has(query))
        if (missing.length) {
          const raw = await this.provider.embed(missing.map((query) => this.textInput(query, true)))
          missing.forEach((query, i) => this.queryVectors.set(query, this.normalize(raw[i])))
        }
        vectors = queries.map((query) => this.queryVectors.get(query)!)
        while (this.queryVectors.size > 64)
          this.queryVectors.delete(this.queryVectors.keys().next().value!)
      }
    }
    signal?.throwIfAborted()
    const cosine = (passage: Passage, vector?: number[]): number => {
      const stored = this.vectors.get(passage.key)
      return vector && stored?.length === vector.length
        ? vector.reduce((sum, value, i) => sum + value * stored[i], 0)
        : 0
    }
    const current = passages
      .map((p) => ({
        p,
        score:
          lexical(`${p.title} ${p.text}`, terms) +
          (named.has(p.meetingId) ? 8 : 0) +
          Math.max(0, cosine(p, vectors[0])) * 4
      }))
      .sort((a, b) => b.score - a.score)
    const context = passages
      .map((p) => ({
        p,
        score:
          lexical(`${p.title} ${p.text}`, contextTerms) +
          (priorIds.includes(p.meetingId) ? 3 : 0) +
          Math.max(0, cosine(p, vectors[1] ?? vectors[0])) * 4
      }))
      .sort((a, b) => b.score - a.score)
    const ranked = new Map<string, { p: Passage; score: number }>()
    for (const [list, weight] of [
      [current, 1.25],
      [context, 1]
    ] as const)
      list.forEach(({ p, score }, i) => {
        if (score <= 0) return
        ranked.set(p.key, { p, score: (ranked.get(p.key)?.score ?? 0) + weight / (12 + i) })
      })
    const meetingScores = new Map<string, number>()
    for (const p of passages)
      meetingScores.set(
        p.meetingId,
        Math.max(meetingScores.get(p.meetingId) ?? 0, cosine(p, vectors[0]))
      )
    const sortedScores = [...meetingScores.values()].sort((a, b) => b - a)
    const score = sortedScores[0] ?? 0
    const margin = score - (sortedScores[1] ?? 0)
    const lexicalAnchor = Math.max(
      0,
      ...terms.map((term) =>
        documents.has(term) ? Math.log(1 + passages.length / documents.get(term)!) : 0
      )
    )
    // Confidence uses meeting frequency, so duplicate notes/transcript chunks
    // and library size do not change how distinctive a query term is.
    const rareTerms = terms.filter((term) => {
      const count = queryMeetings.get(term)?.size ?? 0
      return count > 0 && Math.log1p(scoped.length / count) / Math.log1p(scoped.length) >= 0.75
    })
    const relativeRarity = rareTerms.length > 0
    // Multiple distinctive words can identify the topic even when a synonym
    // makes another meeting's semantic score narrowly higher.
    const lexicalConfident = [...meetingScores].some(([id, similarity]) => {
      const matching = rareTerms.filter((term) => queryMeetings.get(term)?.has(id))
      return (
        similarity >= 0.42 &&
        matching.length >= 2 &&
        matching.some((term) => unicodeContentTokens(term, 4).length > 0)
      )
    })
    const retrievalConfidence = {
      score,
      margin,
      lexicalAnchor,
      confident:
        (score >= 0.42 && margin >= 0.075 && relativeRarity) ||
        lexicalConfident ||
        (score >= 0.65 && margin >= 0.22)
    }
    // A first question with no subject anchor and no confident match is treated as spanning
    // meetings: every ranked meeting is eligible and picking is breadth-first, so the writer sees
    // the most relevant passage of each of the top meetings and judges relevance itself. An
    // absolute similarity floor dropped meetings whose multi-fact passages matched only weakly.
    const carried = new Set(named.size ? [] : carriedIds.slice(0, 2))
    const broad = !retrievalConfidence.confident && !named.size && !carried.size && !history.length
    // Previous results affect ranking, not unconditional factual eligibility.
    const eligible = new Set<string>(named)
    const bestLexical = Math.max(0, ...passages.map((p) => lexical(`${p.title} ${p.text}`, terms)))
    const bestContextLexical = Math.max(
      0,
      ...passages.map((p) => lexical(`${p.title} ${p.text}`, contextTerms))
    )
    for (const p of passages) {
      const score = lexical(`${p.title} ${p.text}`, terms)
      if (score >= Math.max(2.5, bestLexical * 0.7)) eligible.add(p.meetingId)
      // Preserve a real contextual match when embeddings are unavailable;
      // membership in the previous result set alone is never sufficient.
      if (
        history.length &&
        priorIds.includes(p.meetingId) &&
        bestContextLexical > 0 &&
        lexical(`${p.title} ${p.text}`, contextTerms) >= bestContextLexical * 0.7
      )
        eligible.add(p.meetingId)
    }
    if (vectors.length) {
      const best = Math.max(...passages.map((p) => cosine(p, vectors[0])))
      const bestPrior = Math.max(
        0,
        ...passages.filter((p) => priorIds.includes(p.meetingId)).map((p) => cosine(p, vectors[0]))
      )
      const bestContext = Math.max(...passages.map((p) => cosine(p, vectors[1] ?? vectors[0])))
      for (const p of passages) {
        const currentRelevant = cosine(p, vectors[0]) >= Math.max(0.4, best - 0.07)
        const contextualRelevant =
          vectors.length > 1 && cosine(p, vectors[1]) >= Math.max(0.4, bestContext - 0.07)
        // Broad facet words must not bring unrelated meetings into a follow-up.
        // A strongly better current semantic match can still open a new topic.
        const newTopic = cosine(p, vectors[0]) >= bestPrior + 0.12
        if (
          contextualRelevant ||
          (currentRelevant && (!history.length || !priorIds.length || newTopic))
        )
          eligible.add(p.meetingId)
      }
    }
    if (broad) for (const { p } of ranked.values()) eligible.add(p.meetingId)
    const ordered = [...ranked.values()].sort((a, b) => b.score - a.score)
    // Experiment only: preserve the normal cap unless explicitly requested.
    const maxPassages = process.env.AUTODOC_ASK_AI_MAX_PASSAGES === '12' ? 12 : 8
    const picked: Passage[] = []
    const counts = new Map<string, number>()
    const add = (p: Passage): boolean => {
      if (
        picked.length >= maxPassages ||
        (counts.get(p.meetingId) ?? 0) >= (carried.has(p.meetingId) ? 2 : 3)
      )
        return false
      if (
        picked.some(
          (other) =>
            other.meetingId === p.meetingId &&
            normalizeDuplicateEvidence(other.text).includes(normalizeDuplicateEvidence(p.text))
        )
      )
        return false
      picked.push(p)
      counts.set(p.meetingId, (counts.get(p.meetingId) ?? 0) + 1)
      return true
    }
    // Reserve only the explicit primary-meeting carry, ranked by this question.
    // Previous search results remain ranking hints, never automatic eligibility.
    for (const id of carried) for (const { p } of current) if (p.meetingId === id) add(p)
    if (broad) {
      // One best passage per eligible meeting first, so a few meetings cannot fill the cap.
      const firsts = new Set<string>()
      for (const { p } of ordered)
        if (eligible.has(p.meetingId) && !firsts.has(p.meetingId)) {
          firsts.add(p.meetingId)
          add(p)
        }
    }
    for (const { p } of ordered) {
      if (eligible.has(p.meetingId)) add(p)
      if (picked.length >= maxPassages) break
    }
    const primaryMeetingIds = named.size
      ? [...named].slice(0, 2)
      : [
          ordered.find(({ p }) => picked.some((chosen) => chosen.key === p.key))?.p.meetingId ??
            picked[0]?.meetingId
        ].filter((id): id is string => Boolean(id))
    if (useAskAiTopMatch() && vectors.length) {
      const best = passages.reduce((top, p) =>
        cosine(p, vectors[0]) > cosine(top, vectors[0]) ? p : top
      )
      reserveAskAiTopMatch(picked, best, { named: named.size > 0, eligible, carried, counts })
    }
    if (!picked.length) return null
    // Pick order is relevance order; the sort below is for stable writer input only, and the
    // returned object stays byte-identical, so the ranking is reported through a callback.
    onRanked?.([...new Set(picked.map((p) => p.meetingId))])
    picked.sort(
      (a, b) =>
        a.meetingId.localeCompare(b.meetingId) ||
        a.kind.localeCompare(b.kind) ||
        a.key.localeCompare(b.key)
    )
    return {
      intent: 'lookup',
      content: '',
      retrievalConfidence,
      primaryMeetingIds,
      sources: numberSourceCards(
        picked.map((p) => ({
          meetingId: p.meetingId,
          title: p.title,
          quote: p.text,
          startMs: p.startMs,
          category: p.kind
        }))
      ),
      excerpts: picked.map((p) => ({
        ...(useAskAiAppendFollowups() ? { passageId: p.key } : {}),
        meetingId: p.meetingId,
        title: p.title,
        date: p.date,
        kind: p.kind,
        text: p.text
      })),
      selectedMeetingIds: [...new Set(picked.map((p) => p.meetingId))],
      selectedTitles: [...new Set(picked.map((p) => p.title))]
    }
  }

  async retrieve(
    question: string,
    meetings: IndexedMeeting[],
    scopedIds?: string[],
    signal?: AbortSignal,
    canInfer: () => boolean = () => true,
    cachedOnly = false
  ): Promise<AskAiAnswer | null> {
    signal?.throwIfAborted()
    const scoped = scopedIds?.length
      ? meetings.filter((m) => scopedIds.includes(m.meetingId))
      : filterMeetingsForQuestionWindow(meetings, question)
    let passages = this.passages(scoped)
    if (!passages.length) return null
    const terms = evidenceTerms(question)
    const facet = questionFacet(question)
    if (
      !canInfer() &&
      facet &&
      !passages.some((p) => matchesEvidenceFacet(question, p.text, p.title))
    )
      return null
    const titleAnchors = terms.filter(
      (term) =>
        ![
          'launch',
          'review',
          'meeting',
          'meetings',
          'budget',
          'engineering',
          'plan',
          'service',
          'recording',
          'notes'
        ].includes(term)
    )
    const lexicalFact =
      facet &&
      passages.some(
        (p) =>
          matchesEvidenceFacet(question, p.text, p.title) &&
          (scopedIds?.includes(p.meetingId) ||
            titleAnchors.some((term) => p.title.toLowerCase().includes(term)))
      )
    // Already-grounded, title-scoped facts must not queue indexing/embedding
    // behind notes. Rich/ambiguous questions retain semantic retrieval when idle.
    if (!lexicalFact && canInfer()) {
      if (!cachedOnly) await this.prepare(meetings, canInfer)
      passages = this.passages(scoped)
    }
    const lexical = passages
      .map((p) => ({
        p,
        score:
          (lexicalFact && facet?.test(p.text) ? 4 : 0) +
          terms.reduce(
            (sum, t) =>
              sum +
              (p.text.toLowerCase().includes(t) ? 1 : 0) +
              (p.title.toLowerCase().includes(t) ? 2 : 0),
            0
          )
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
    let semantic: Array<{ p: Passage; score: number }> = []
    if (cachedOnly) await this.semanticAvailable(true)
    const cachedQuery = this.queryVectors.get(question)
    if (
      !lexicalFact &&
      (cachedQuery || (canInfer() && (await this.semanticAvailable(cachedOnly))))
    ) {
      const query = cachedQuery ?? (canInfer() ? await this.queryVector(question) : null)
      if (query) {
        semantic = passages
          .map((p) => {
            const vector = this.vectors.get(p.key)
            const score =
              vector?.length === query.length
                ? query.reduce((sum, v, i) => sum + v * vector[i], 0)
                : -1
            return { p, score }
          })
          .filter((r) => r.score >= 0.35)
          .sort((a, b) => b.score - a.score)
      }
    }
    signal?.throwIfAborted()
    const bestSemantic = semantic[0]?.score ?? 0
    semantic = semantic.filter((row) => row.score >= Math.max(0.35, bestSemantic - 0.1))
    const bestLexical = lexical[0]?.score ?? 0
    const wantsTranscript = /\btranscripts?\b|文字起こし/iu.test(question)
    const focusedLexical = lexical.filter(
      (row) =>
        row.score >= Math.max(2, bestLexical * 0.75) ||
        (wantsTranscript &&
          row.p.kind === 'transcript' &&
          (scopedIds?.includes(row.p.meetingId) ||
            titleAnchors.some((term) => row.p.title.toLowerCase().includes(term))))
    )
    const rank = new Map<string, { p: Passage; score: number }>()
    for (const list of [focusedLexical, semantic])
      list.forEach(({ p }, i) => {
        const old = rank.get(p.key)
        rank.set(p.key, { p, score: (old?.score ?? 0) + 1 / (60 + i + 1) })
      })
    const titleTerms = unicodeContentTokens(question, 3).filter(
      (term) =>
        ![
          'launch',
          'review',
          'meeting',
          'meetings',
          'budget',
          'engineering',
          'plan',
          'service',
          'recording',
          'notes'
        ].includes(term)
    )
    const titleCounts = new Map<string, number>()
    for (const passage of passages)
      titleCounts.set(
        passage.meetingId,
        titleTerms.filter((term) => passage.title.toLowerCase().includes(term)).length
      )
    const bestTitle = Math.max(0, ...titleCounts.values())
    const detailed = wantsDetailedAskAiAnswer(question)
    const picked: Passage[] = []
    const counts = new Map<string, number>()
    for (const { p } of [...rank.values()].sort((a, b) => b.score - a.score)) {
      if (bestTitle > 0 && (titleCounts.get(p.meetingId) ?? 0) < bestTitle) continue
      if (lexicalFact && !matchesEvidenceFacet(question, p.text, p.title)) continue
      const kindKey = `${p.meetingId}:${p.kind}`
      if ((counts.get(kindKey) ?? 0) >= (detailed ? 3 : 1)) continue
      // Avoid spending context on a transcript copy of a note already selected.
      if (
        picked.some(
          (other) =>
            other.meetingId === p.meetingId &&
            normalizeDuplicateEvidence(other.text).includes(normalizeDuplicateEvidence(p.text))
        )
      )
        continue
      picked.push(p)
      counts.set(kindKey, (counts.get(kindKey) ?? 0) + 1)
      if (picked.length === (detailed ? 12 : 6)) break
    }
    if (!picked.length) return null
    return {
      intent: 'lookup',
      content: picked.map((p, i) => `> ${p.text}\n\n[${i + 1}] ${p.title}`).join('\n\n'),
      sources: numberSourceCards(
        picked.map((p) => ({
          meetingId: p.meetingId,
          title: p.title,
          quote: p.text,
          startMs: p.startMs,
          category: p.kind
        }))
      ),
      excerpts: picked.map((p) => ({
        meetingId: p.meetingId,
        title: p.title,
        date: p.date,
        kind: p.kind,
        text: p.text
      })),
      selectedMeetingIds: [...new Set(picked.map((p) => p.meetingId))],
      selectedTitles: [...new Set(picked.map((p) => p.title))]
    }
  }
}
