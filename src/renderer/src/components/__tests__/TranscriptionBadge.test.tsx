import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { TranscriptionBadge } from '../TranscriptionBadge'
import { createElectronApiMock } from '../../test/fixtures'

beforeEach(() => {
  window.electronAPI = createElectronApiMock({
    'whisper:get-setup-status': { phase: 'ready', percent: 100 }
  }) as any
})

describe('TranscriptionBadge', () => {
  it('shows "Awaiting transcription" for pending status', () => {
    render(<TranscriptionBadge status="pending" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows "Awaiting transcription" for queued status', () => {
    render(<TranscriptionBadge status="queued" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows whisper setup progress for downloading status', async () => {
    window.electronAPI = createElectronApiMock({
      'whisper:get-setup-status': { phase: 'checking', percent: 0 }
    }) as any

    render(<TranscriptionBadge status="downloading" />)
    expect(await screen.findByText('Checking transcription engine...')).toBeInTheDocument()
  })

  it('shows "Transcribing..." for transcribing status without progress', () => {
    render(<TranscriptionBadge status="transcribing" />)
    expect(screen.getByText('Transcribing...')).toBeInTheDocument()
  })

  it('shows percentage when transcribing with progress', () => {
    render(<TranscriptionBadge status="transcribing" progress={42} />)
    expect(screen.getByText('Transcribing 42%')).toBeInTheDocument()
  })

  it('shows "Identifying speakers..." for diarizing status', () => {
    render(<TranscriptionBadge status="diarizing" />)
    expect(screen.getByText('Identifying speakers...')).toBeInTheDocument()
  })

  it('shows "Transcribed" for complete status', () => {
    render(<TranscriptionBadge status="complete" />)
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
  })

  it('shows "Failed — Retry" for failed status', () => {
    render(<TranscriptionBadge status="failed" />)
    expect(screen.getByText('Failed — Retry')).toBeInTheDocument()
  })

  it('calls onRetry when failed badge is clicked', () => {
    const onRetry = vi.fn()
    render(<TranscriptionBadge status="failed" onRetry={onRetry} />)
    fireEvent.click(screen.getByText('Failed — Retry'))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
