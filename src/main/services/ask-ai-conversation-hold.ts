interface ConversationHold {
  pending: Promise<void>
  release?: () => void
  answers: number
  lastActivity: number
  closed: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** One notes lease per renderer conversation; answer completion starts quiet time. */
export class AskAiConversationHolds {
  private holds = new Map<number, ConversationHold>()
  private readonly quietMs = 60_000

  async begin(
    owner: number,
    acquire: () => Promise<(() => void) | undefined>
  ): Promise<() => void> {
    let hold = this.holds.get(owner)
    if (!hold) {
      hold = { pending: Promise.resolve(), answers: 0, lastActivity: Date.now(), closed: false }
      const created = hold
      this.holds.set(owner, created)
      created.pending = Promise.resolve()
        .then(acquire)
        .then((release) => {
          if (created.closed) {
            release?.()
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

  private closeHold(owner: number, hold: ConversationHold): void {
    if (hold.closed) return
    hold.closed = true
    clearTimeout(hold.timer)
    if (this.holds.get(owner) === hold) this.holds.delete(owner)
    hold.release?.()
    hold.release = undefined
  }
}
