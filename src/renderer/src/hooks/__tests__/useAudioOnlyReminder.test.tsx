import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_ONLY_REMINDER_DELAY_MS, useAudioOnlyReminder } from '../useAudioOnlyReminder'

const send = vi.fn()

type Props = { isRecording: boolean; meetingId: string | null; videoDisabled: boolean }
const audioOnly: Props = { isRecording: true, meetingId: 'm1', videoDisabled: true }

beforeEach(() => {
  vi.useFakeTimers()
  send.mockClear()
  window.electronAPI = { send, invoke: vi.fn(), on: vi.fn(() => () => {}) } as never
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(initial: Props = audioOnly) {
  return renderHook((props: Props) => useAudioOnlyReminder(props), { initialProps: initial })
}

describe('useAudioOnlyReminder', () => {
  it('uses a five minute delay', () => {
    expect(AUDIO_ONLY_REMINDER_DELAY_MS).toBe(5 * 60 * 1000)
  })

  it('does not show before the delay and shows after it, notifying once', () => {
    const { result } = setup()
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS - 1))
    expect(result.current.visible).toBe(false)
    expect(send).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(result.current.visible).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      'recording:audio-only-reminder',
      'Recording audio only',
      'Video stopped 5 minutes ago. AutoDoc is still recording audio.'
    )

    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS * 3))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('never starts while video is on', () => {
    const { result } = setup({ ...audioOnly, videoDisabled: false })
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS * 2))
    expect(result.current.visible).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('cancels when the recording stops, before and after the reminder', () => {
    const { result, rerender } = setup()
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS - 1000))
    rerender({ isRecording: false, meetingId: null, videoDisabled: false })
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS))
    expect(result.current.visible).toBe(false)
    expect(send).not.toHaveBeenCalled()

    rerender(audioOnly)
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS))
    expect(result.current.visible).toBe(true)
    rerender({ isRecording: false, meetingId: null, videoDisabled: false })
    expect(result.current.visible).toBe(false)
  })

  it('cancels when video recovers, and restarts a fresh timer on a later video stop', () => {
    const { result, rerender } = setup()
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS - 1000))
    rerender({ ...audioOnly, videoDisabled: false })
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS))
    expect(send).not.toHaveBeenCalled()

    rerender(audioOnly)
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS - 1))
    expect(send).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.visible).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)

    rerender({ ...audioOnly, videoDisabled: false })
    expect(result.current.visible).toBe(false)
    rerender(audioOnly)
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS))
    expect(result.current.visible).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stays dismissed for the rest of the video stop after Keep recording', () => {
    const { result } = setup()
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS))
    act(() => result.current.dismiss())
    expect(result.current.visible).toBe(false)
    act(() => vi.advanceTimersByTime(AUDIO_ONLY_REMINDER_DELAY_MS * 5))
    expect(result.current.visible).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('honours an injected delay', () => {
    const { result } = renderHook(() => useAudioOnlyReminder({ ...audioOnly, delayMs: 1000 }))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.visible).toBe(true)
  })
})
