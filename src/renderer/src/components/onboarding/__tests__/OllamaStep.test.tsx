import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { OllamaStep } from '../OllamaStep'

describe('OllamaStep', () => {
  it('renders AI setup heading', () => {
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 42 })
    render(<OllamaStep onNext={vi.fn()} />)
    expect(screen.getByText('Setting Up AI')).toBeInTheDocument()
  })

  it('auto-advances when already ready', async () => {
    const onNext = vi.fn()
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'ready', percent: 100 })
    render(<OllamaStep onNext={onNext} />)
    await act(() => Promise.resolve())
    expect(onNext).toHaveBeenCalled()
  })

  it('shows skip link after 5 seconds', () => {
    vi.useFakeTimers()
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 10 })
    render(<OllamaStep onNext={vi.fn()} />)
    expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText(/continue/i)).toBeInTheDocument()
    vi.useRealTimers()
  })
})
