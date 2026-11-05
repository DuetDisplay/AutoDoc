import type { AskAiIndexStatus } from '../../shared/ask-ai-index-status'
import { logAutodocEvent } from './autodoc-log'

export const useAskAiIndexPrewarm = (): boolean => process.env.AUTODOC_ASK_AI_INDEX_PREWARM !== '0'

/** A single foreground-sized batch is too small to warrant a preparation notice. */
const NOTICE_PASSAGES = 16
const RETRY_BASE_MS = 5_000
const RETRY_CAP_MS = 30_000
const FAILURE_LIMIT = 5

type Progress = (done: number, total: number, added: number) => void
export type AskAiPrepareResult = 'ready' | 'paused' | 'unavailable'

export class AskAiIndexPrewarm {
  private requested = false
  private dirty = false
  private stopped = false
  private generation = 0
  private active: AbortController | null = null
  private checking = false
  private planning: Promise<void> | null = null
  private inspectionComplete = false
  private failures = 0
  private retryAfter = 0
  private completed = 0
  private queryReady = false
  private total = 0
  private lastPublishedAt = 0
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private publishedState: AskAiIndexStatus['state'] = 'idle'
  private status: AskAiIndexStatus = { state: 'idle', percent: 0, significant: false }
  private timer: ReturnType<typeof setInterval>

  constructor(
    private options: {
      canRun: () => boolean | Promise<boolean>
      inspect: () => Promise<{
        completed: number
        total: number
        semanticReady?: boolean
        unavailable?: boolean
        needsSave?: boolean
      }>
      prepare: (signal: AbortSignal, progress: Progress) => Promise<AskAiPrepareResult>
      onChange?: (status: AskAiIndexStatus) => void
      onIdle?: () => void
    }
  ) {
    this.timer = setInterval(() => void this.tick(), 250)
    this.timer.unref?.()
  }
  get ready(): boolean {
    return this.status.state === 'ready'
  }
  get semanticReady(): boolean {
    return this.queryReady || this.ready
  }
  async whenInspected(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const expired = new Promise<boolean>((resolve, reject) => {
      timer = setTimeout(() => resolve(false), 2000)
      if (signal) {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    try {
      return await Promise.race([
        (async () => {
          while (this.planning) await this.planning
          return this.inspectionComplete || this.ready || this.unavailable
        })(),
        expired
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }
  get unavailable(): boolean {
    return this.status.state === 'unavailable'
  }
  snapshot(): AskAiIndexStatus {
    return { ...this.status }
  }

  request(): void {
    if (this.stopped) return
    if (!this.requested || this.ready || this.unavailable)
      this.status = { state: 'preparing', percent: 0, significant: false }
    this.requested = true
    this.failures = 0
    this.retryAfter = 0
    this.dirty = true
    this.generation++
    this.active?.abort()
    this.queryReady = false
    this.inspectionComplete = false
    this.setState('preparing')
    // Inspection restores/upgrades derived coverage metadata without model inference.
    const planning = this.options
      .inspect()
      .then(({ completed, total, semanticReady, unavailable, needsSave }) => {
        if (this.planning !== planning || this.stopped) return
        this.inspectionComplete = true
        this.completed = completed
        this.total = total
        if (unavailable) {
          this.queryReady = false
          this.dirty = false
          this.setState('unavailable')
          this.options.onIdle?.()
          return
        }
        this.queryReady = semanticReady ?? completed === total
        if (completed === total) {
          this.dirty = Boolean(needsSave)
          this.setState('ready')
          this.options.onIdle?.()
          return
        }
        this.progress(completed, total)
      })
      .catch(() => {})
      .finally(() => {
        if (this.planning === planning) this.planning = null
        void this.tick()
      })
    this.planning = planning
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.active?.abort()
  }
  private publish(): void {
    const now = Date.now()
    if (this.status.state !== this.publishedState || now - this.lastPublishedAt >= 1000) {
      if (this.publishTimer) clearTimeout(this.publishTimer)
      this.publishTimer = null
      this.publishedState = this.status.state
      this.lastPublishedAt = now
      this.options.onChange?.(this.snapshot())
    } else if (!this.publishTimer) {
      this.publishTimer = setTimeout(
        () => {
          this.publishTimer = null
          if (!this.stopped) {
            this.lastPublishedAt = Date.now()
            this.options.onChange?.(this.snapshot())
          }
        },
        1000 - (now - this.lastPublishedAt)
      )
      this.publishTimer.unref?.()
    }
  }
  private setState(state: AskAiIndexStatus['state']): void {
    this.status = { ...this.status, state }
    if (state === 'ready') this.status.percent = 100
    this.publish()
  }
  private progress(done: number, total: number): void {
    this.completed = done
    this.total = total
    this.status.significant ||= total - done > NOTICE_PASSAGES
    this.status.percent = Math.max(
      this.status.percent,
      total ? Math.min(99, Math.floor((done / total) * 100)) : 0
    )
    this.publish()
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.checking) return
    this.checking = true
    try {
      const allowed = await this.options.canRun()
      if (this.stopped) return
      if (!allowed) {
        this.active?.abort()
        if (!this.ready && !this.unavailable && (this.dirty || this.active)) this.setState('paused')
        return
      }
      if (this.ready || this.unavailable) this.options.onIdle?.()
      if (!this.dirty || this.active || this.planning || Date.now() < this.retryAfter) return
      this.dirty = false
      const generation = this.generation
      const controller = new AbortController()
      this.active = controller
      const started = Date.now()
      let added = 0,
        lastLogged = 0
      this.setState('preparing')
      logAutodocEvent({ area: 'chat', message: 'Ask AI index prewarm started' })
      void this.options
        .prepare(controller.signal, (done, total, count) => {
          if (generation !== this.generation) return
          this.progress(done, total)
          if (count > added) this.failures = 0
          added = count
          if (done - lastLogged >= 128) {
            lastLogged = done
            logAutodocEvent({
              area: 'chat',
              message: 'Ask AI index prewarm progress',
              context: { completed: done, total, newEmbeddings: count }
            })
          }
        })
        .then(async (result) => {
          if (this.stopped || generation !== this.generation) return
          const context = {
            elapsedMs: Date.now() - started,
            completed: this.completed,
            total: this.total,
            newEmbeddings: added
          }
          if (controller.signal.aborted || result === 'paused' || !(await this.options.canRun())) {
            this.dirty = true
            this.setState('paused')
            logAutodocEvent({ area: 'chat', message: 'Ask AI index prewarm paused', context })
          } else if (result === 'unavailable') {
            this.dirty = false
            this.setState('unavailable')
            this.options.onIdle?.()
            logAutodocEvent({ area: 'chat', message: 'Ask AI index prewarm unavailable', context })
          } else if (this.completed === this.total) {
            this.failures = 0
            this.setState('ready')
            this.options.onIdle?.()
            logAutodocEvent({
              area: 'chat',
              message: 'Ask AI index prewarm completed',
              context: { ...context, ready: true }
            })
          } else {
            this.dirty = true
          }
        })
        .catch((error) => {
          if (this.stopped || generation !== this.generation) return
          if (controller.signal.aborted) {
            this.dirty = true
            this.setState('paused')
            logAutodocEvent({
              area: 'chat',
              message: 'Ask AI index prewarm paused',
              context: {
                elapsedMs: Date.now() - started,
                completed: this.completed,
                total: this.total,
                newEmbeddings: added
              }
            })
          } else {
            this.failures++
            this.dirty = this.failures < FAILURE_LIMIT
            const backoffMs = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
            this.retryAfter = Date.now() + backoffMs
            this.setState(this.dirty ? 'preparing' : 'unavailable')
            if (!this.dirty) this.options.onIdle?.()
            logAutodocEvent({
              area: 'chat',
              message: this.dirty
                ? 'Ask AI index prewarm retry scheduled'
                : 'Ask AI index prewarm unavailable',
              context: {
                elapsedMs: Date.now() - started,
                completed: this.completed,
                total: this.total,
                failures: this.failures,
                backoffMs,
                error: error instanceof Error ? error.name : 'Error'
              }
            })
          }
        })
        .finally(() => {
          if (this.active === controller) this.active = null
        })
    } catch {
      /* Startup/shutdown can make readiness unavailable temporarily. */
    } finally {
      this.checking = false
    }
  }
}
