import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Onboarding } from '../Onboarding'

describe('Onboarding', () => {
  it('renders welcome screen first', () => {
    render(<Onboarding onComplete={vi.fn()} />)
    expect(screen.getByText(/your meetings talk/i)).toBeInTheDocument()
    expect(screen.getByText('Get Started →')).toBeInTheDocument()
  })

  it('advances to next screen on Get Started click', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(screen.getByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
  })

  it('navigates through feature screens with Next', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(screen.getByText('Get Started →'))
    // Screen 2: Private
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    // Screen 3: How It Works
    expect(screen.getByText('How It Works')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    // Screen 4: Notes That Think
    expect(screen.getByText('Notes That Think')).toBeInTheDocument()
  })

  it('renders step dots', () => {
    render(<Onboarding onComplete={vi.fn()} />)
    const dots = document.querySelectorAll('[data-testid="step-dot"]')
    expect(dots.length).toBe(9)
  })
})
