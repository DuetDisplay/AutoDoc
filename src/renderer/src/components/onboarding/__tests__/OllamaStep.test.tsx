import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { OllamaStep } from '../OllamaStep'

describe('OllamaStep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders AI setup heading', async () => {
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 42 })

    await act(async () => {
      render(<OllamaStep onNext={vi.fn()} />)
      await Promise.resolve()
    })

    expect(screen.getByText('Setting Up AI')).toBeInTheDocument()
  })

  it('auto-advances when already ready', async () => {
    const onNext = vi.fn()
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'ready', percent: 100 })

    await act(async () => {
      render(<OllamaStep onNext={onNext} />)
      await Promise.resolve()
    })

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(onNext).toHaveBeenCalled()
  })

  it('shows skip link after 5 seconds', async () => {
    vi.mocked(window.electronAPI.invoke).mockResolvedValue({ phase: 'downloading', percent: 10 })

    await act(async () => {
      render(<OllamaStep onNext={vi.fn()} />)
      await Promise.resolve()
    })

    expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText(/continue/i)).toBeInTheDocument()
  })
})
