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

  it('shows "Generating notes..." label for segmenting status at zero percent', () => {
    render(<SegmentationBadge status="segmenting" progress={0} />)
    expect(screen.getByText('Generating notes... 0%')).toBeInTheDocument()
  })

  it('shows "Notes ready" for complete status', () => {
    render(<SegmentationBadge status="complete" />)
    expect(screen.getByText('Notes ready')).toBeInTheDocument()
  })
})
