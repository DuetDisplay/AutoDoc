import { EventEmitter } from 'events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AskAiConversationHolds } from '../ask-ai-conversation-hold'
let holds: AskAiConversationHolds
beforeEach(() => {
  vi.useFakeTimers()
  holds = new AskAiConversationHolds()
})
afterEach(() => {
  holds.closeAll()
  vi.useRealTimers()
})
it('keeps exactly one hold across back-to-back questions, with one notes resume', async () => {
  const resume = vi.fn(),
    acquire = vi.fn(async () => resume)
  const first = await holds.begin(1, acquire)
  first()
  await vi.advanceTimersByTimeAsync(20_000)
  const second = await holds.begin(1, acquire)
  expect(acquire).toHaveBeenCalledOnce()
  expect(resume).not.toHaveBeenCalled()
  second()
  second()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(resume).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(resume).toHaveBeenCalledOnce()
  holds.close(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(resume).toHaveBeenCalledOnce()
})
it('starts sixty seconds of quiet when the answer ends, not when it starts', async () => {
  const resume = vi.fn()
  const end = await holds.begin(1, async () => resume)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(resume).not.toHaveBeenCalled()
  end()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(resume).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(resume).toHaveBeenCalledOnce()
})
it('typing extends the quiet window using the last keystroke time', async () => {
  const resume = vi.fn()
  ;(await holds.begin(1, async () => resume))()
  await vi.advanceTimersByTimeAsync(55_000)
  const typedAt = Date.now()
  await vi.advanceTimersByTimeAsync(4_000)
  holds.activity(1, typedAt)
  await vi.advanceTimersByTimeAsync(55_999)
  expect(resume).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(resume).toHaveBeenCalledOnce()
})
it('closing the view releases at once and the former answer cannot schedule another resume', async () => {
  const resume = vi.fn()
  const end = await holds.begin(1, async () => resume)
  holds.close(1)
  expect(resume).toHaveBeenCalledOnce()
  end()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(resume).toHaveBeenCalledOnce()
})
it('releases a pending acquisition once if the view closes while notes are yielding', async () => {
  const resume = vi.fn()
  let finish!: (release: () => void) => void
  const pending = holds.begin(
    1,
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await Promise.resolve()
  holds.close(1)
  finish(resume)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(resume).toHaveBeenCalledOnce()
})
it('releases all conversations on a normal close', async () => {
  const resumeA = vi.fn(),
    resumeB = vi.fn()
  await holds.begin(1, async () => resumeA)
  await holds.begin(2, async () => resumeB)
  holds.closeAll()
  expect(resumeA).toHaveBeenCalledOnce()
  expect(resumeB).toHaveBeenCalledOnce()
})

it('drops active and pending holds on quit without resuming stopped notes', async () => {
  const resume = vi.fn(),
    pendingResume = vi.fn(),
    acquire = vi.fn(async () => resume)
  const end = await holds.begin(1, acquire)
  let finish!: (release: () => void) => void
  const pending = holds.begin(
    2,
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await Promise.resolve()
  holds.shutdown()
  finish(pendingResume)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  end()
  holds.closeAll()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(resume).not.toHaveBeenCalled()
  expect(pendingResume).not.toHaveBeenCalled()
  await expect(holds.begin(3, acquire)).rejects.toMatchObject({ name: 'AbortError' })
  expect(acquire).toHaveBeenCalledOnce()
})
it.each(['destroyed', 'render-process-gone', 'did-start-navigation', 'did-navigate-in-page'])(
  'releases immediately on sender %s and removes listeners',
  async (event) => {
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
    const resume = vi.fn(),
      acquire = vi.fn(async () => resume)
    const end = await holds.begin(sender as never, acquire)
    const second = await holds.begin(sender as never, acquire)
    expect(sender.listenerCount(event)).toBe(1)
    if (event === 'did-navigate-in-page') sender.emit(event, {}, 'file:///index.html#/search', true)
    else sender.emit(event, { isMainFrame: true })
    expect(resume).toHaveBeenCalledOnce()
    end()
    second()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(resume).toHaveBeenCalledOnce()
    expect(sender.eventNames()).toEqual([])
  }
)
it('ignores subframe navigation and releases a pending hold on sender destruction', async () => {
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
  const resume = vi.fn()
  let finish!: (release: () => void) => void
  const pending = holds.begin(
    sender as never,
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await Promise.resolve()
  sender.emit('did-start-navigation', { isMainFrame: false })
  expect(sender.listenerCount('destroyed')).toBe(1)
  sender.emit('destroyed')
  finish(resume)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(resume).toHaveBeenCalledOnce()
  expect(sender.eventNames()).toEqual([])
})
