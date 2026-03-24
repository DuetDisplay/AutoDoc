import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TranscriptionBadge } from '../TranscriptionBadge'

describe('TranscriptionBadge', () => {
  it('shows "Awaiting transcription" for pending status', () => {
    render(<TranscriptionBadge status="pending" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows "Awaiting transcription" for queued status', () => {
    render(<TranscriptionBadge status="queued" />)
    expect(screen.getByText('Awaiting transcription')).toBeInTheDocument()
  })

  it('shows "Downloading model..." for downloading status', () => {
    render(<TranscriptionBadge status="downloading" />)
    expect(screen.getByText('Downloading model...')).toBeInTheDocument()
  })

  it('shows "Transcribing..." for transcribing status', () => {
    render(<TranscriptionBadge status="transcribing" />)
    expect(screen.getByText('Transcribing...')).toBeInTheDocument()
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
