import { logAutodocEvent } from './autodoc-log'

export type LocalProcessingKind = 'transcription' | 'segmentation'

interface Waiter {
  kind: LocalProcessingKind
  resolve: () => void
}

type ShouldSerializeLocalProcessing = () => boolean | Promise<boolean>

export class LocalProcessingCoordinator {
  private activeKind: LocalProcessingKind | null = null
  private waiters: Waiter[] = []
  private windowsAdmission: Promise<void> = Promise.resolve()
  private windowsActive = new Set<Promise<void>>()
  private windowsExclusive = false

  constructor(private shouldSerialize: ShouldSerializeLocalProcessing) {}

  async isSerializing(): Promise<boolean> {
    return await this.shouldSerialize()
  }

  getActiveKind(): LocalProcessingKind | null {
    return this.activeKind
  }

  /** Track even concurrent Windows work so a later CPU downgrade can drain it. */
  async runWindows<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const completed = new Promise<void>((resolve) => {
      release = resolve
    })
    const admission = this.windowsAdmission.then(async () => {
      const serialize = await this.shouldSerialize()
      if (this.windowsExclusive || serialize) {
        await Promise.all(this.windowsActive)
      }
      this.windowsExclusive = serialize
      this.windowsActive.add(completed)
    })
    this.windowsAdmission = admission.catch(() => {})
    await admission
    try {
      return await fn()
    } finally {
      this.windowsActive.delete(completed)
      release()
    }
  }

  async runExclusive<T>(
    kind: LocalProcessingKind,
    meetingId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!(await this.shouldSerialize())) {
      return await fn()
    }

    await this.acquire(kind, meetingId)
    try {
      return await fn()
    } finally {
      this.release(kind, meetingId)
    }
  }

  private async acquire(kind: LocalProcessingKind, meetingId: string): Promise<void> {
    if (!this.activeKind) {
      this.activeKind = kind
      return
    }

    logAutodocEvent({
      area: kind,
      message: 'local processing waiting for serialized lane',
      meetingId,
      context: {
        waitingKind: kind,
        activeKind: this.activeKind
      }
    })

    await new Promise<void>((resolve) => {
      this.waiters.push({ kind, resolve })
    })
    this.activeKind = kind
  }

  private release(kind: LocalProcessingKind, meetingId: string): void {
    if (this.activeKind !== kind) {
      return
    }

    const next = this.waiters.shift()
    if (!next) {
      this.activeKind = null
      return
    }

    logAutodocEvent({
      area: next.kind,
      message: 'local processing serialized lane granted',
      meetingId,
      context: {
        previousKind: kind,
        nextKind: next.kind,
        remainingWaiters: this.waiters.length
      }
    })
    next.resolve()
  }
}
