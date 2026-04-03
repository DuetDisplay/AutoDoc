import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScreenPermissionStep } from '../ScreenPermissionStep'

describe('ScreenPermissionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-screen-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })
  })

  it('restores the restart state after returning from System Settings', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-screen-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<ScreenPermissionStep onNext={onNext} />)

    await waitFor(() => {
      expect(screen.getByText('Restart AutoDoc')).toBeInTheDocument()
    })
    expect(screen.getByText('Continue without restarting')).toBeInTheDocument()
  })

  it('clears the persisted restart state when continuing without restarting', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-screen-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'prefs:set-onboarding-screen-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<ScreenPermissionStep onNext={onNext} />)

    await userEvent.click(await screen.findByText('Continue without restarting'))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-screen-settings-opened',
      false,
    )
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('auto-advances after relaunch when screen permission is granted', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-screen-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: true })
      if (channel === 'prefs:set-onboarding-screen-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    const onNext = vi.fn()
    render(<ScreenPermissionStep onNext={onNext} />)

    await waitFor(() => {
      expect(onNext).toHaveBeenCalledTimes(1)
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-onboarding-screen-settings-opened',
      false,
    )
  })
})
