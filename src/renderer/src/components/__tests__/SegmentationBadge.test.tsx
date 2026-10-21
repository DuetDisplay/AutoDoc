import { render, screen } from '@testing-library/react'
import { beforeEach, describe, it, expect } from 'vitest'
import { SegmentationBadge } from '../SegmentationBadge'
import { createElectronApiMock } from '../../test/fixtures'

beforeEach(() => {
  window.electronAPI = createElectronApiMock({
    'ollama:get-setup-status': { phase: 'ready', percent: 100 }
  }) as any
})

describe('SegmentationBadge', () => {
  it('shows "Preparing notes..." when segmenting without progress', () => {
    render(<SegmentationBadge status="segmenting" />)
    expect(screen.getByText('Preparing notes...')).toBeInTheDocument()
  })

  it('shows percentage when segmenting with progress', () => {
    render(<SegmentationBadge status="segmenting" progress={42} />)
    expect(screen.getByText('Generating notes... 42%')).toBeInTheDocument()
  })

  it('shows shaping copy after the writer band so scan work is not a frozen 99%', () => {
    render(<SegmentationBadge status="segmenting" progress={70} />)
    expect(screen.getByText('Shaping notes... 70%')).toBeInTheDocument()
  })

  it('shows "Generating notes..." label for segmenting status at zero percent', () => {
    render(<SegmentationBadge status="segmenting" progress={0} />)
    expect(screen.getByText('Generating notes... 0%')).toBeInTheDocument()
  })

  it('shows "Notes ready" for complete status', () => {
    render(<SegmentationBadge status="complete" />)
    expect(screen.getByText('Notes ready')).toBeInTheDocument()
  })

  it('shows "No notes generated" for no-notes status', () => {
    render(<SegmentationBadge status="no-notes" />)
    expect(screen.getByText('No notes generated')).toBeInTheDocument()
  })

  it('says no notes were found, and still offers retry, when nothing was accepted', () => {
    let retried = false
    render(
      <SegmentationBadge
        status="failed"
        errorCode="llm-empty-output"
        onRetry={() => {
          retried = true
        }}
      />
    )
    screen.getByText('No notes found — Retry').click()
    expect(retried).toBe(true)
  })

  it('keeps the generic failure label for other errors', () => {
    render(<SegmentationBadge status="failed" errorCode="unknown" />)
    expect(screen.getByText('Notes failed — Retry')).toBeInTheDocument()
  })
})
