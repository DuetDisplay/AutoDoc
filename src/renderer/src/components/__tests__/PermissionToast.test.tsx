import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionToast } from '../PermissionToast'
import { useToastStore } from '../../stores/toast'

describe('PermissionToast', () => {
  beforeEach(() => {
    useToastStore.setState({ activeToast: null })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when no active toast', () => {
    const { container } = render(<PermissionToast />)
    expect(container.firstChild).toBeNull()
  })

  it('renders toast message when active', () => {
    useToastStore.setState({
      activeToast: { type: 'screen', message: 'Enable screen recording' },
    })
    render(<PermissionToast />)
    expect(screen.getByText('Enable screen recording')).toBeInTheDocument()
  })

  it('dismisses on X click', async () => {
    vi.useRealTimers()
    useToastStore.setState({
      activeToast: { type: 'screen', message: 'test' },
    })
    render(<PermissionToast />)
    await userEvent.click(screen.getByTitle('Dismiss'))
    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('auto-dismisses after 8 seconds', () => {
    useToastStore.setState({
      activeToast: { type: 'microphone', message: 'test' },
    })
    render(<PermissionToast />)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(useToastStore.getState().activeToast).toBeNull()
  })
})
