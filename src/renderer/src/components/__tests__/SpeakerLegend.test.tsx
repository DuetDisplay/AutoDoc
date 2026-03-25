import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpeakerLegend } from '../SpeakerLegend'

describe('SpeakerLegend', () => {
  const speakers = {
    me: { label: 'Me' },
    speaker_1: { label: 'Speaker 1', suggestions: ['alice@co.com'] },
    speaker_2: { label: 'Speaker 2', suggestions: ['alice@co.com'] },
  }

  it('renders all speaker labels', () => {
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1', 'speaker_2']} onRename={vi.fn()} />)
    expect(screen.getByText('Me')).toBeInTheDocument()
    expect(screen.getByText('Speaker 1')).toBeInTheDocument()
    expect(screen.getByText('Speaker 2')).toBeInTheDocument()
  })

  it('does not show rename button for "me"', () => {
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1']} onRename={vi.fn()} />)
    const renameButtons = screen.getAllByText('rename')
    expect(renameButtons).toHaveLength(1)
  })

  it('calls onRename when a suggestion is clicked', async () => {
    const onRename = vi.fn()
    render(<SpeakerLegend speakers={speakers} speakerIds={['me', 'speaker_1']} onRename={onRename} />)
    fireEvent.click(screen.getByText('rename'))
    fireEvent.click(screen.getByText('alice@co.com'))
    expect(onRename).toHaveBeenCalledWith('speaker_1', 'alice@co.com')
  })
})
