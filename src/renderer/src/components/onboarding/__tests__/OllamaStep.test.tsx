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
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'ollama:get-setup-status') {
        return Promise.resolve({ phase: 'downloading', percent: 42 })
      }
      return Promise.resolve()
    })

    await act(async () => {
      render(<OllamaStep onNext={vi.fn()} />)
      await Promise.resolve()
    })

    expect(screen.getByText('Setting Up AI')).toBeInTheDocument()
  })

  it('waits for confirmation when already ready', async () => {
    const onNext = vi.fn()
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'ollama:get-setup-status') {
        return Promise.resolve({ phase: 'ready', percent: 100 })
      }
      return Promise.resolve()
    })

    await act(async () => {
      render(<OllamaStep onNext={onNext} />)
      await Promise.resolve()
    })

    expect(screen.getByRole('heading', { name: 'AI Model Ready' })).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(onNext).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: /^continue$/i }).click()
    })

    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('starts AI setup when onboarding reaches the step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'ollama:get-setup-status') {
        return Promise.resolve({ phase: 'starting', percent: 0 })
      }
      if (channel === 'ollama:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve()
    })

    await act(async () => {
      render(<OllamaStep onNext={vi.fn()} />)
      await Promise.resolve()
    })

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('ollama:retry-setup')
  })

  it('shows skip link after 1.5 seconds', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'ollama:get-setup-status') {
        return Promise.resolve({ phase: 'downloading', percent: 10 })
      }
      return Promise.resolve()
    })

    await act(async () => {
      render(<OllamaStep onNext={vi.fn()} />)
      await Promise.resolve()
    })

    expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(screen.getByText(/continue/i)).toBeInTheDocument()
  })
})
