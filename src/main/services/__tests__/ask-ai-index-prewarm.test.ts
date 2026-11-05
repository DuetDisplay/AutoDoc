import { afterEach, expect, it, vi } from 'vitest'
import { AskAiIndexPrewarm, useAskAiIndexPrewarm } from '../ask-ai-index-prewarm'
vi.mock('../autodoc-log', () => ({ logAutodocEvent: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('bounds a stalled inspection to two seconds and cancels the request wait promptly', async () => {
  vi.useFakeTimers()
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => false,
    inspect: () => new Promise(() => {}),
    prepare: vi.fn()
  })
  try {
    scheduler.request()
    let settled = false
    const timed = scheduler.whenInspected().then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(settled).toBe(true)
    expect(await timed).toBe(false)
    const controller = new AbortController()
    const aborted = scheduler.whenInspected(controller.signal)
    const assertion = expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
  } finally {
    scheduler.stop()
  }
})

it('does not report partial preparation ready when the gate has already reopened', async () => {
  vi.useFakeTimers()
  let calls = 0
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => true,
    inspect: async () => ({ completed: 0, total: 20 }),
    prepare: async (_signal, progress) => {
      if (++calls === 1) {
        progress(3, 20, 3)
        return 'paused'
      }
      progress(20, 20, 17)
      return 'ready'
    }
  })
  try {
    scheduler.request()
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.ready).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(scheduler.ready).toBe(true)
  } finally {
    scheduler.stop()
  }
})

it('halts unavailable embeddings, caps exponential retries, and rechecks on a real trigger', async () => {
  vi.useFakeTimers()
  const prepare = vi.fn(
    async (
      _signal: AbortSignal,
      _progress: (done: number, total: number, added: number) => void
    ): Promise<'unavailable' | 'ready'> => 'unavailable'
  )
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => true,
    inspect: async () => ({ completed: 0, total: 20 }),
    prepare
  })
  try {
    scheduler.request()
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.unavailable).toBe(true)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(prepare).toHaveBeenCalledTimes(1)
    prepare.mockRejectedValue(new Error('temporary'))
    scheduler.request()
    await vi.advanceTimersByTimeAsync(250)
    for (const delay of [5_000, 10_000, 20_000, 30_000])
      await vi.advanceTimersByTimeAsync(delay + 250)
    expect(prepare).toHaveBeenCalledTimes(6)
    expect(scheduler.unavailable).toBe(true)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(prepare).toHaveBeenCalledTimes(6)
    prepare.mockImplementation(async (_signal, progress) => {
      progress(20, 20, 20)
      return 'ready'
    })
    scheduler.request()
    await vi.advanceTimersByTimeAsync(250)
    expect(scheduler.ready).toBe(true)
  } finally {
    scheduler.stop()
  }
})

it('publishes state changes immediately, throttles percentages and never moves progress backwards', async () => {
  vi.useFakeTimers()
  let busy = false
  let report!: (a: number, b: number, c: number) => void
  let finish!: () => void
  const onChange = vi.fn()
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => !busy,
    inspect: async () => ({ completed: 0, total: 100 }),
    onChange,
    prepare: async (_signal, progress) => {
      report = progress
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return 'ready'
    }
  })
  try {
    scheduler.request()
    await vi.advanceTimersByTimeAsync(1)
    onChange.mockClear()
    report(60, 100, 60)
    report(20, 100, 20)
    expect(scheduler.snapshot().percent).toBe(60)
    expect(onChange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onChange).toHaveBeenCalledTimes(1)
    busy = true
    await vi.advanceTimersByTimeAsync(250)
    expect(onChange.mock.lastCall?.[0].state).toBe('paused')
    busy = false
    report(100, 100, 100)
    finish()
    await vi.advanceTimersByTimeAsync(1)
    // The aborted cycle must be retried, not declared ready.
    expect(scheduler.ready).toBe(false)
  } finally {
    scheduler.stop()
  }
})

it('recognizes a cached complete index while notes gate background inference', async () => {
  vi.useFakeTimers()
  const prepare = vi.fn()
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => false,
    inspect: async () => ({ completed: 100, total: 100, semanticReady: true }),
    prepare
  })
  try {
    scheduler.request()
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.ready).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    scheduler.stop()
  }
})
it('resets consecutive failures after any successful batch', async () => {
  vi.useFakeTimers()
  const prepare = vi.fn(
    async (
      _signal: AbortSignal,
      progress: (done: number, total: number, added: number) => void
    ): Promise<'ready'> => {
      progress(1, 100, 1)
      throw new Error('later batch stalled')
    }
  )
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => true,
    inspect: async () => ({ completed: 0, total: 100 }),
    prepare
  })
  try {
    scheduler.request()
    for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(5250)
    expect(prepare.mock.calls.length).toBeGreaterThan(5)
    expect(scheduler.unavailable).toBe(false)
  } finally {
    scheduler.stop()
  }
})

it('does not let an obsolete paused preparation overwrite a newer complete-cache inspection', async () => {
  vi.useFakeTimers()
  let allowed = true,
    inspected = false,
    finish!: () => void
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => allowed,
    inspect: async () => ({ completed: inspected ? 100 : 0, total: 100 }),
    prepare: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return 'paused'
    }
  })
  try {
    scheduler.request()
    await vi.advanceTimersByTimeAsync(1)
    allowed = false
    inspected = true
    scheduler.request()
    await scheduler.whenInspected()
    expect(scheduler.ready).toBe(true)
    finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.ready).toBe(true)
  } finally {
    scheduler.stop()
  }
})

it('waits for the latest inspection when a request supersedes an in-flight one', async () => {
  vi.useFakeTimers()
  const releases: Array<() => void> = []
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => false,
    inspect: async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return { completed: 100, total: 100 }
    },
    prepare: vi.fn()
  })
  try {
    scheduler.request()
    let settled = false
    const waiting = scheduler.whenInspected().then(() => {
      settled = true
    })
    scheduler.request()
    releases[0]()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    releases[1]()
    await waiting
    expect(scheduler.ready).toBe(true)
  } finally {
    scheduler.stop()
  }
})

it('keeps definitive embedding unavailability hidden while notes block background work', async () => {
  vi.useFakeTimers()
  const prepare = vi.fn()
  const scheduler = new AskAiIndexPrewarm({
    canRun: () => false,
    inspect: async () => ({ completed: 0, total: 100, unavailable: true }),
    prepare
  })
  try {
    scheduler.request()
    await scheduler.whenInspected()
    await vi.advanceTimersByTimeAsync(250)
    expect(scheduler.unavailable).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    scheduler.stop()
  }
})

it('prewarms by default on every platform and only an explicit 0 turns it off', () => {
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', undefined)
  expect(useAskAiIndexPrewarm()).toBe(true)
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '1')
  expect(useAskAiIndexPrewarm()).toBe(true)
  vi.stubEnv('AUTODOC_ASK_AI_INDEX_PREWARM', '0')
  expect(useAskAiIndexPrewarm()).toBe(false)
})
