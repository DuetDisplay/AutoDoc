import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Onboarding } from '../Onboarding'
import { createRuntimeInfo, resetRendererStores } from '../../test/fixtures'

beforeEach(() => {
  resetRendererStores()
  vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
    if (channel === 'prefs:get-onboarding-step') return Promise.resolve(0)
    if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
    if (channel === 'calendar:get-accounts') return Promise.resolve([])
    if (channel === 'whisper:get-setup-status') return Promise.resolve({ phase: 'ready', percent: 100 })
    if (channel === 'ollama:get-setup-status') return Promise.resolve({ phase: 'ready', percent: 100 })
    return Promise.resolve({} as never)
  })
})

describe('Onboarding', () => {
  it('renders welcome screen first', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    expect(await screen.findByText(/your meetings talk/i)).toBeInTheDocument()
    expect(screen.getByText('Get Started →')).toBeInTheDocument()
  })

  it('advances to next screen on Get Started click', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(await screen.findByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
  })

  it('navigates through feature screens with Next', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await userEvent.click(await screen.findByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    expect(screen.getByText('How It Works')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Next →'))
    expect(screen.getByText('Notes That Think')).toBeInTheDocument()
  })

  it('renders step dots', async () => {
    render(<Onboarding onComplete={vi.fn()} />)
    await screen.findByText(/your meetings talk/i)
    await waitFor(() => {
      const dots = document.querySelectorAll('[data-testid="step-dot"]')
      expect(dots.length).toBe(10)
    })
  })

  it('resumes from the saved onboarding step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(6)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Connect Calendar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument()
  })

  it('persists the analytics opt-in choice and advances to the all-set step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(9)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-analytics-consent') return Promise.resolve(args[0])
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(undefined)
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: /share anonymous data/i }))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-analytics-consent', true)
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-onboarding-step', 10)
    })

    expect(await screen.findByRole('heading', { name: /you’re all set|you're all set/i })).toBeInTheDocument()
  })

  it('skips macOS permission steps on Windows', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(0)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo({ platform: 'win32' }))
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      if (channel === 'whisper:get-setup-status') return Promise.resolve({ phase: 'ready', percent: 100 })
      if (channel === 'ollama:get-setup-status') return Promise.resolve({ phase: 'ready', percent: 100 })
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)
    await screen.findByText(/your meetings talk/i)

    await waitFor(() => {
      const dots = document.querySelectorAll('[data-testid="step-dot"]')
      expect(dots.length).toBe(8)
    })
  })

  it('migrates saved Windows permission-step progress to calendar', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(5)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo({ platform: 'win32' }))
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(args[0])
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Connect Calendar' })).toBeInTheDocument()

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-onboarding-step', 6)
    })
  })
})
