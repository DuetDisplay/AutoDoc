import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScreenPermissionStep } from '../ScreenPermissionStep'

describe('ScreenPermissionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })
  })

  it('restores the continue state after returning from System Settings', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })

    render(<ScreenPermissionStep onNext={vi.fn()} />)

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
    render(<ScreenPermissionStep onNext={onNext} />)

    await userEvent.click(await screen.findByText('Continue →'))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-permission-settings-opened',
      'screen',
      false,
    )
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('auto-advances after relaunch when screen permission is already granted', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: true })
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<ScreenPermissionStep onNext={onNext} />)

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1)
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-permission-settings-opened',
      'screen',
      false,
    )
  })
})
