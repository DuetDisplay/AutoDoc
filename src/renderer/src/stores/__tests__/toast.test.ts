import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useToastStore } from '../toast'

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ activeToast: null })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no active toast', () => {
    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('shows a toast', () => {
    useToastStore.getState().showToast({ type: 'screen', message: 'Enable screen recording' })
    expect(useToastStore.getState().activeToast).toEqual({
      type: 'screen',
      message: 'Enable screen recording',
    })
  })

  it('dismisses a toast', () => {
    useToastStore.getState().showToast({ type: 'screen', message: 'test' })
    useToastStore.getState().dismissToast()
    expect(useToastStore.getState().activeToast).toBeNull()
  })
})
