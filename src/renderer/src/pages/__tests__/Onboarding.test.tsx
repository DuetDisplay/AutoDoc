import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Onboarding } from '../Onboarding'

beforeEach(() => {
  vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ..._args: unknown[]) => {
    if (channel === 'prefs:get-onboarding-step') return Promise.resolve(0)
    return Promise.resolve({})
  })
})

describe('Onboarding', () => {
  it('renders welcome screen first', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText(/your meetings talk/i)).toBeInTheDocument()
    })
    expect(screen.getByText('Get Started →')).toBeInTheDocument()
  })

  it('advances to next screen on Get Started click', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Get Started →')).toBeInTheDocument()
    })
    await userEvent.click(screen.getByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
  })

  it('navigates through feature screens with Next', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Get Started →')).toBeInTheDocument()
    })
    await userEvent.click(screen.getByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    expect(screen.getByText('How It Works')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    expect(screen.getByText('Notes That Think')).toBeInTheDocument()
  })

  it('renders step dots', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await waitFor(() => {
      const dots = document.querySelectorAll('[data-testid="step-dot"]')
      expect(dots.length).toBe(10)
    })
  })

  it('resumes from persisted step on mount', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ..._args: unknown[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(1)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })
    render(<Onboarding onComplete={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Private by Design')).toBeInTheDocument()
    })
  })
})
