import type { WebContents } from 'electron'

type ConversationOwner = Pick<WebContents, 'id' | 'on' | 'removeListener' | 'isDestroyed'>
interface ConversationHold {
  pending: Promise<void>
  release?: () => void
  answers: number
  lastActivity: number
  closed: boolean
  resumeOnClose: boolean
  cleanup?: () => void
  timer?: ReturnType<typeof setTimeout>
}

/** One notes lease per renderer conversation; answer completion starts quiet time. */
export class AskAiConversationHolds {
  private holds = new Map<number, ConversationHold>()
  private readonly quietMs = 60_000
  private stopped = false

  async begin(
    sender: ConversationOwner | number,
    acquire: () => Promise<(() => void) | undefined>
  ): Promise<() => void> {
    const owner = typeof sender === 'number' ? sender : sender.id
    if (this.stopped || (typeof sender !== 'number' && sender.isDestroyed?.()))
      throw new DOMException('Ask AI closed', 'AbortError')
    let hold = this.holds.get(owner)
    if (!hold) {
      hold = {
        pending: Promise.resolve(),
        answers: 0,
        lastActivity: Date.now(),
        closed: false,
        resumeOnClose: true
      }
      const created = hold
      this.holds.set(owner, created)
      if (typeof sender !== 'number' && sender.on) {
        const close = () => this.closeHold(owner, created)
        const navigate = (details: { isMainFrame: boolean }) => {
          if (details.isMainFrame) close()
        }
        const navigateInPage = (_event: unknown, _url: string, isMainFrame: boolean) => {
          if (isMainFrame) close()
        }
        sender.on('destroyed', close)
        sender.on('render-process-gone', close)
        sender.on('did-start-navigation', navigate)
        sender.on('did-navigate-in-page', navigateInPage)
        created.cleanup = () => {
          sender.removeListener('destroyed', close)
          sender.removeListener('render-process-gone', close)
          sender.removeListener('did-start-navigation', navigate)
          sender.removeListener('did-navigate-in-page', navigateInPage)
        }
      }
      created.pending = Promise.resolve()
        .then(() => {
          if (created.closed) throw new DOMException('Ask AI closed', 'AbortError')
          return acquire()
        })
        .then((release) => {
          if (created.closed) {
            if (created.resumeOnClose) release?.()
            throw new DOMException('Ask AI closed', 'AbortError')
          }
          created.release = release
        })
        .catch((error) => {
          this.closeHold(owner, created)
          throw error
        })
    }
    const current = hold
    current.answers++
    current.lastActivity = Date.now()
    clearTimeout(current.timer)
    await current.pending
    let finished = false
    return () => {
      if (finished || current.closed) return
      finished = true
      current.answers = Math.max(0, current.answers - 1)
      current.lastActivity = Date.now()
      if (!current.release) this.closeHold(owner, current)
      else this.schedule(owner, current)
    }
  }

  activity(owner: number, typedAt: number): void {
    const hold = this.holds.get(owner)
    if (!hold || hold.closed) return
    // Renderer reports at most every ten seconds. Use its last keystroke time,
    // bounded by that reporting interval, rather than extending by a timer delay.
    const now = Date.now()
    const at = Number.isFinite(typedAt) ? Math.max(now - 10_000, Math.min(now, typedAt)) : now
    hold.lastActivity = Math.max(hold.lastActivity, at)
    this.schedule(owner, hold)
  }

  close(owner: number): void {
    const hold = this.holds.get(owner)
    if (hold) this.closeHold(owner, hold)
  }

  closeAll(): void {
    for (const [owner, hold] of this.holds) this.closeHold(owner, hold)
  }

  /** At will-quit Ollama may already be stopped. Never restart queued notes. */
  shutdown(): void {
    this.stopped = true
    for (const [owner, hold] of this.holds) this.closeHold(owner, hold, false)
  }

  private schedule(owner: number, hold: ConversationHold): void {
    clearTimeout(hold.timer)
    if (hold.closed || hold.answers > 0) return
    hold.timer = setTimeout(
      () => {
        if (Date.now() - hold.lastActivity >= this.quietMs) this.closeHold(owner, hold)
        else this.schedule(owner, hold)
      },
      Math.max(0, hold.lastActivity + this.quietMs - Date.now())
    )
    hold.timer.unref?.()
  }

  private closeHold(owner: number, hold: ConversationHold, resume = true): void {
    if (hold.closed) return
    hold.closed = true
    hold.resumeOnClose = resume
    clearTimeout(hold.timer)
    hold.cleanup?.()
    if (this.holds.get(owner) === hold) this.holds.delete(owner)
    if (resume) hold.release?.()
    hold.release = undefined
  }
}
