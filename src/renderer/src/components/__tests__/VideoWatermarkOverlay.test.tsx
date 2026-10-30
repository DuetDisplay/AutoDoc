import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VideoWatermarkOverlay } from '../VideoWatermarkOverlay'

describe('VideoWatermarkOverlay', () => {
  it('renders the readable translucent watermark without obstructing video controls', () => {
    const { container } = render(<VideoWatermarkOverlay />)
    const watermark = container.firstElementChild

    expect(watermark).not.toBeNull()
    expect(watermark).toHaveTextContent(/^Meeting notes by AutoDoc$/)
    expect(watermark).toHaveAttribute('aria-hidden', 'true')
    expect(watermark).toHaveClass(
      'pointer-events-none',
      'absolute',
      'top-3',
      'right-3',
      'border-white/5',
      'bg-black/70',
      'text-white',
      '[&:popover-open]:fixed'
    )
    expect(watermark?.querySelectorAll('svg rect')).toHaveLength(4)
    expect(watermark?.querySelector('svg')).toHaveClass('text-white/85')
    expect(screen.getByText('Meeting notes by AutoDoc')).toBeInTheDocument()
  })
})
