import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

  it('shows install guidance for missing macOS Whisper dependencies', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'whisper-cli not found. Install it with: brew install whisper-cpp',
        })
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Install Whisper to Continue')).toBeInTheDocument()
    expect(screen.getByText(/runs transcription locally on your Mac/i)).toBeInTheDocument()
    expect(screen.getByText(/Open Terminal and run:/i)).toBeInTheDocument()
    expect(screen.getByText('Retry After Installing')).toBeInTheDocument()
    expect(screen.getByText(/brew install whisper-cpp/i)).toBeInTheDocument()
  })

  it('retries setup after the dependency has been installed', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'whisper-cli not found. Install it with: brew install whisper-cpp',
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    await userEvent.click(await screen.findByText('Retry After Installing'))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
  })

  it('keeps the generic retry UI for non-install failures', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'whisper:get-setup-status') {
        return Promise.resolve({
          phase: 'error',
          percent: 0,
          error: 'Network request failed',
        })
      }
      if (channel === 'whisper:retry-setup') {
        return Promise.resolve()
      }
      return Promise.resolve({})
    })

    render(<TranscriptionStep onNext={vi.fn()} />)

    expect(await screen.findByText('Retry')).toBeInTheDocument()
    expect(screen.queryByText('Install Whisper')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('whisper:retry-setup')
    })
  })
})
