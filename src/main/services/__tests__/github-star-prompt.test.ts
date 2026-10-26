import { describe, it, expect, vi } from 'vitest'
vi.mock('electron-store', () => ({ default: class {} }))
import {
  GithubStarPromptService,
  isSuccessfulStarMeeting,
  type GithubStarPromptState,
  type GithubStarPromptOptions
} from '../github-star-prompt'
const DAY = 86400000,
  NOW = new Date(2026, 9, 26, 12).getTime()
function setup(
  overrides: Partial<GithubStarPromptOptions> = {},
  initial: Partial<GithubStarPromptState> = {}
) {
  let state: GithubStarPromptState = {
    activatedAt: NOW,
    qualifiedMeetingId: null,
    shownAt: null,
    ...initial
  }
  let now = NOW
  const store = {
    read: () => ({ ...state }),
    write: vi.fn((next: GithubStarPromptState) => {
      state = next
    })
  }
  const options = {
    store,
    now: () => now,
    isBusy: () => false,
    isOnboardingComplete: () => true,
    feedbackTakesPriority: async () => false,
    isGoodMeeting: async () => true,
    ...overrides
  }
  return {
    service: new GithubStarPromptService(options),
    options,
    store,
    state: () => state,
    advance: (ms: number) => {
      now += ms
    }
  }
}
describe('one-time local GitHub star request', () => {
  it('ignores existing notes until a new good completion has been recorded', async () => {
    const x = setup()
    expect(await x.service.reserve()).toBeNull()
    await x.service.recordCompletedMeeting('next-meeting')
    expect(x.state().qualifiedMeetingId).toBe('next-meeting')
    expect(await x.service.reserve()).toBeTypeOf('string')
  })
  it('does not consume an unseen reservation and rechecks feedback and busy gates on confirmation', async () => {
    let busy = false,
      feedback = false
    const x = setup(
      { isBusy: () => busy, feedbackTakesPriority: async () => feedback },
      { qualifiedMeetingId: 'good' }
    )
    const id = (await x.service.reserve())!
    x.service.cancel(id)
    expect(x.state().shownAt).toBeNull()
    const second = (await x.service.reserve())!
    feedback = true
    expect(await x.service.confirm(second)).toBe(false)
    expect(x.state().shownAt).toBeNull()
    feedback = false
    const third = (await x.service.reserve())!
    busy = true
    expect(await x.service.confirm(third)).toBe(false)
  })
  it('expires unconfirmed reservations and prevents concurrent duplicate cards', async () => {
    const x = setup({}, { qualifiedMeetingId: 'good' })
    const ids = await Promise.all([x.service.reserve(), x.service.reserve()])
    expect(ids.filter(Boolean)).toHaveLength(1)
    x.advance(15001)
    expect(await x.service.confirm(ids.find(Boolean)!)).toBe(false)
    expect(await x.service.reserve()).toBeTypeOf('string')
  })
  it('persists the first impression across updates and restarts, even without a click', async () => {
    const x = setup({}, { qualifiedMeetingId: 'good' })
    const id = (await x.service.reserve())!
    expect(await x.service.confirm(id)).toBe(true)
    expect(x.state().shownAt).toBe(NOW)
    expect(await x.service.reserve()).toBeNull()
    expect(await new GithubStarPromptService(x.options).reserve()).toBeNull()
  })
  it('blocks feedback for the same local day and for the rest of the process session', async () => {
    const x = setup({}, { qualifiedMeetingId: 'good' })
    await x.service.confirm((await x.service.reserve())!)
    expect(x.service.blocksFeedback()).toBe(true)
    x.advance(DAY)
    expect(x.service.blocksFeedback()).toBe(true)
    expect(new GithubStarPromptService(x.options).blocksFeedback()).toBe(false)
  })
  it.each(['isBusy', 'feedbackTakesPriority', 'isOnboardingComplete'] as const)(
    'respects the %s gate',
    async (key) => {
      const options =
        key === 'isOnboardingComplete' ? { [key]: () => false } : { [key]: () => true }
      const x = setup(options, { qualifiedMeetingId: 'good' })
      expect(await x.service.reserve()).toBeNull()
    }
  )
  it('checks that notes are still good, including feedback changes during the disk read', async () => {
    let feedback = false
    const x = setup(
      {
        isGoodMeeting: async () => {
          feedback = true
          return true
        },
        feedbackTakesPriority: async () => feedback
      },
      { qualifiedMeetingId: 'good' }
    )
    expect(await x.service.reserve()).toBeNull()
    const y = setup({ isGoodMeeting: async () => false }, { qualifiedMeetingId: 'deleted' })
    expect(await y.service.reserve()).toBeNull()
  })
  it('fails quietly when local state cannot be read or written', async () => {
    const x = setup({
      store: {
        read: () => null,
        write: () => {
          throw new Error('disk')
        }
      }
    })
    await x.service.recordCompletedMeeting('good')
    expect(await x.service.reserve()).toBeNull()
    const y = setup({}, { qualifiedMeetingId: 'good' })
    const id = (await y.service.reserve())!
    y.store.write.mockImplementation(() => {
      throw new Error('disk')
    })
    expect(await y.service.confirm(id)).toBe(false)
  })
})
describe('good notes requirement', () => {
  const meta = { sourceName: 'Meeting', startedAt: 0, stoppedAt: 180000, durationSeconds: 180 }
  it('accepts exactly three minutes with non-empty successful notes', () => {
    expect(isSuccessfulStarMeeting(meta, 'complete', 'complete', true)).toBe(true)
  })
  it.each([0, 30, 179, NaN])('rejects invalid or short duration %s', (durationSeconds) => {
    expect(
      isSuccessfulStarMeeting({ ...meta, durationSeconds }, 'complete', 'complete', true)
    ).toBe(false)
  })
  it('rejects empty notes, failures, partial capture, finalization and retained old notes after a failed retry', () => {
    expect(isSuccessfulStarMeeting(meta, 'complete', 'complete', false)).toBe(false)
    expect(isSuccessfulStarMeeting(meta, 'failed', 'complete', true)).toBe(false)
    expect(isSuccessfulStarMeeting(meta, 'complete', 'failed', true)).toBe(false)
    expect(isSuccessfulStarMeeting(meta, 'complete', 'complete', true, 'writer-failed')).toBe(false)
    for (const patch of [
      { isFinalizing: true },
      { videoCaptureEndedEarly: true },
      { videoProcessingFailed: true },
      { videoStatus: 'failed' as const }
    ])
      expect(isSuccessfulStarMeeting({ ...meta, ...patch }, 'complete', 'complete', true)).toBe(
        false
      )
  })
})
