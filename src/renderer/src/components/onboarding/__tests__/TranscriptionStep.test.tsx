import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TranscriptionStep } from '../TranscriptionStep'

describe('TranscriptionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({ phase: 'checking', percent: 0 })
      }
      return Promise.resolve({})
    })
  })

  it('shows managed setup messaging during installation', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'downloading-whisper',
          percent: 42,
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Setting Up Transcription')).toBeInTheDocument()
    expect(screen.getByText(/one-time local transcription setup/i)).toBeInTheDocument()
    expect(screen.getByText(/downloading transcription engine\.\.\. 42%/i)).toBeInTheDocument()
    expect(screen.queryByText(/brew install/i)).not.toBeInTheDocument()
  })

  it('retries setup after a managed install failure', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'Download request failed',
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('We hit a setup issue')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
    expect(screen.queryByText(/Open Terminal/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
    })
  })

  it('keeps the background-continue affordance for in-progress setup', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
        if (channel === 'whisper:get-setup-status') {
          return Promise.resolve({
            phase: 'downloading-model',
            percent: 10,
          })
        }
        return Promise.resolve({})
      })

      await act(async () => {
        render(<TranscriptionStep onNext={vi.fn()} />)
        await Promise.resolve()
      })

      expect(screen.queryByText(/continue/i)).not.toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      expect(screen.getByText(/continue - this will finish in the background/i)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
