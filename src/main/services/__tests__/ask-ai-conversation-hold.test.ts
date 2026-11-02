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
it('releases all conversations on app quit', async () => {
  const resumeA = vi.fn(),
    resumeB = vi.fn()
  await holds.begin(1, async () => resumeA)
  await holds.begin(2, async () => resumeB)
  holds.closeAll()
  expect(resumeA).toHaveBeenCalledOnce()
  expect(resumeB).toHaveBeenCalledOnce()
})
