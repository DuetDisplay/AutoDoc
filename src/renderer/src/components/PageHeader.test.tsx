import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { PageHeader } from './PageHeader'

describe('PageHeader', () => {
  it('renders title', () => {
    render(<PageHeader title="Upcoming" />)
    expect(screen.getByText('Upcoming')).toBeInTheDocument()
  })

  it('renders subtitle when provided', () => {
    render(<PageHeader title="Upcoming" subtitle="Monday, March 24" />)
    expect(screen.getByText('Monday, March 24')).toBeInTheDocument()
  })

  it('renders action slot when provided', () => {
    render(<PageHeader title="Test" action={<button>Click</button>} />)
    expect(screen.getByText('Click')).toBeInTheDocument()
  })
})
