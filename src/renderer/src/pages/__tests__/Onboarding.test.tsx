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
    if (channel === 'whisper:get-setup-status')
      return Promise.resolve({ phase: 'ready', percent: 100 })
    if (channel === 'ollama:get-setup-status')
      return Promise.resolve({ phase: 'ready', percent: 100 })
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

  it('goes back to the previous onboarding screen and persists the previous step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(0)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(args[0])
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      if (channel === 'whisper:get-setup-status')
        return Promise.resolve({ phase: 'ready', percent: 100 })
      if (channel === 'ollama:get-setup-status')
        return Promise.resolve({ phase: 'ready', percent: 100 })
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    await userEvent.click(await screen.findByText('Get Started →'))
    expect(screen.getByText('Private by Design')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(await screen.findByText(/your meetings talk/i)).toBeInTheDocument()
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-onboarding-step', 0)
  })

  it('does not auto-skip a granted permission step when navigating back from calendar', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(6)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(args[0])
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      if (channel === 'permissions:check')
        return Promise.resolve({ microphone: true, screen: true })
      if (channel === 'prefs:get-onboarding-permission-settings-opened')
        return Promise.resolve(false)
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Connect Calendar' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(await screen.findByRole('heading', { name: 'Screen Recording' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^continue/i })).toBeInTheDocument()
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-onboarding-step', 5)
  })

  it('does not auto-skip a granted permission step when resuming saved progress', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(5)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'permissions:check')
        return Promise.resolve({ microphone: true, screen: true })
      if (channel === 'prefs:get-onboarding-permission-settings-opened')
        return Promise.resolve(false)
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Screen Recording' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^continue/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Connect Calendar' })).not.toBeInTheDocument()
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

  it('surfaces onboarding calendar connection failures so users can recover', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(6)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      if (channel === 'calendar:connect') return Promise.reject(new Error('OAuth denied'))
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /we couldn't connect google calendar/i
    )
    expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument()
  })

  it('persists the analytics opt-in choice and advances to the all-set step', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(9)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-analytics-consent') return Promise.resolve(args[0])
      if (channel === 'prefs:set-diagnostic-log-upload-consent') return Promise.resolve(args[0])
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(undefined)
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: /share anonymous data/i }))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-analytics-consent', true)
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-diagnostic-log-upload-consent',
        false
      )
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-onboarding-step', 10)
    })

    expect(
      await screen.findByRole('heading', { name: /you’re all set|you're all set/i })
    ).toBeInTheDocument()
  })

  it('allows analytics opt-in while leaving diagnostic log upload off', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: any[]) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(9)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-analytics-consent') return Promise.resolve(args[0])
      if (channel === 'prefs:set-diagnostic-log-upload-consent') return Promise.resolve(args[0])
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(undefined)
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    expect(checkbox).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /share anonymous data/i }))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-analytics-consent', true)
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-diagnostic-log-upload-consent',
        false
      )
    })
  })

  it('preserves the diagnostic log upload choice when navigating back and forward from analytics', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(9)
      if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
      if (channel === 'prefs:set-onboarding-step') return Promise.resolve(undefined)
      if (channel === 'ollama:get-setup-status')
        return Promise.resolve({ phase: 'ready', percent: 100 })
      return Promise.resolve({} as never)
    })

    render(<Onboarding onComplete={vi.fn()} />)

    const checkbox = await screen.findByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByRole('heading', { name: /AI/i })).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('button', { name: /^continue$/i }))

    const restoredCheckbox = await screen.findByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    expect(restoredCheckbox).toBeChecked()
  })

  it('skips macOS permission steps on Windows', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return Promise.resolve(0)
      if (channel === 'app:get-runtime-info')
        return Promise.resolve(createRuntimeInfo({ platform: 'win32' }))
      if (channel === 'calendar:get-accounts') return Promise.resolve([])
      if (channel === 'whisper:get-setup-status')
        return Promise.resolve({ phase: 'ready', percent: 100 })
      if (channel === 'ollama:get-setup-status')
        return Promise.resolve({ phase: 'ready', percent: 100 })
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
      if (channel === 'app:get-runtime-info')
        return Promise.resolve(createRuntimeInfo({ platform: 'win32' }))
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
