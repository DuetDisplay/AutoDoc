import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MicPermissionStep } from '../MicPermissionStep'

describe('MicPermissionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('denied')),
      },
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'permissions:request-microphone-access') return Promise.resolve(false)
      return Promise.resolve({})
    })
  })

  it('renders required badge and enable button', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.getByText('REQUIRED')).toBeInTheDocument()
    expect(screen.getByText('Enable Microphone')).toBeInTheDocument()
    expect(screen.getByText('Use headphones for the clearest notes')).toBeInTheDocument()
    expect(
      screen.getByText(/help AutoDoc tell your voice apart from everyone else's/i)
    ).toBeInTheDocument()
  })

  it('does not show Continue until permission granted', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.queryByText('Continue →')).not.toBeInTheDocument()
  })

  it('restores the continue state after returning from System Settings', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })

    render(<MicPermissionStep onNext={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Continue →')).toBeInTheDocument()
    })
    expect(screen.getByText('Open Settings again')).toBeInTheDocument()
  })

  it('clears persisted state when continuing after restart', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<MicPermissionStep onNext={onNext} />)

    await userEvent.click(await screen.findByText('Continue →'))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-permission-settings-opened',
      'microphone',
      false,
    )
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('auto-advances after relaunch when microphone permission is already granted', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: true, screen: false })
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<MicPermissionStep onNext={onNext} />)

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1)
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-permission-settings-opened',
      'microphone',
      false,
    )
  })

  it('marks mic access granted after getUserMedia succeeds and OS mic access is reported granted', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: true, screen: false })
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<MicPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Microphone'))

    await waitFor(() => {
      expect(screen.getByText('Continue →')).toBeInTheDocument()
    })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith('permissions:request-microphone-access')
  })

  it('requests app-side microphone access when the renderer probe does not grant access', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    let permissionChecks = 0
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') {
        permissionChecks += 1
        return Promise.resolve({
          microphone: permissionChecks >= 3,
          screen: false,
        })
      }
      if (channel === 'permissions:request-microphone-access') return Promise.resolve(true)
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<MicPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Microphone'))

    await waitFor(() => {
      expect(screen.getByText('Continue →')).toBeInTheDocument()
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:request-microphone-access')
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith('permissions:open-settings', 'microphone')
  })

  it('falls back to System Settings when getUserMedia succeeds but OS mic access is still not granted', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'permissions:request-microphone-access') return Promise.resolve(false)
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      if (channel === 'permissions:open-settings') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<MicPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Microphone'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-onboarding-permission-settings-opened',
        'microphone',
        true,
      )
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:request-microphone-access')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:open-settings', 'microphone')
    expect(await screen.findByText('Open Settings again')).toBeInTheDocument()
  })

  it('opens System Settings when getUserMedia fails and mic access is still not granted', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'permissions:request-microphone-access') return Promise.resolve(false)
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      if (channel === 'permissions:open-settings') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<MicPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Microphone'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-onboarding-permission-settings-opened',
        'microphone',
        true,
      )
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:request-microphone-access')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:open-settings', 'microphone')
  })
})
