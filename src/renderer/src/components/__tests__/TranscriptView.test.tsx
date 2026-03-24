import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TranscriptView } from '../TranscriptView'
import type { Transcript } from '../../../../shared/types'

const sampleTranscripts: Transcript[] = [
  { id: 'seg-0', meetingId: 'm1', speaker: 'Speaker', text: 'Hello everyone', startMs: 0, endMs: 3000, confidence: -1 },
  { id: 'seg-1', meetingId: 'm1', speaker: 'Speaker', text: 'Let us begin the meeting', startMs: 3000, endMs: 7500, confidence: -1 },
]

describe('TranscriptView', () => {
  it('renders transcript segments with timestamps', () => {
    render(<TranscriptView segments={sampleTranscripts} status="complete" />)
    expect(screen.getByText('Hello everyone')).toBeInTheDocument()
    expect(screen.getByText('Let us begin the meeting')).toBeInTheDocument()
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('0:03')).toBeInTheDocument()
  })

  it('shows transcribing message when status is transcribing', () => {
    render(<TranscriptView segments={[]} status="transcribing" />)
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument()
  })

  it('shows downloading message when status is downloading', () => {
    render(<TranscriptView segments={[]} status="downloading" />)
    expect(screen.getByText(/downloading/i)).toBeInTheDocument()
  })

  it('shows pending message when status is pending', () => {
    render(<TranscriptView segments={[]} status="pending" />)
    expect(screen.getByText(/awaiting/i)).toBeInTheDocument()
  })

  it('shows empty state when complete with no segments', () => {
    render(<TranscriptView segments={[]} status="complete" />)
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument()
  })
})
