import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScreenPermissionStep } from '../ScreenPermissionStep'

describe('ScreenPermissionStep', () => {
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
      if (channel === 'recording:get-sources') return Promise.resolve([{ id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }])
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

  it('marks screen access granted after desktop capture succeeds and OS screen access is reported granted', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: true })
      if (channel === 'recording:get-sources') return Promise.resolve([{ id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }])
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<ScreenPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Screen Recording'))

    await waitFor(() => {
      expect(screen.getByText('Continue →')).toBeInTheDocument()
    })
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: 'screen:0',
          maxFrameRate: 1,
        },
      },
    })
  })

  it('falls back to System Settings when desktop capture succeeds but OS screen access is still not granted', async () => {
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
      if (channel === 'recording:get-sources') return Promise.resolve([{ id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }])
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      if (channel === 'permissions:open-settings') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<ScreenPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Screen Recording'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-onboarding-permission-settings-opened',
        'screen',
        true,
      )
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:open-settings', 'screen')
    expect(screen.getByText('Open Settings again')).toBeInTheDocument()
  })

  it('opens System Settings when desktop capture fails and screen access is still not granted', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(false)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'recording:get-sources') return Promise.resolve([{ id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }])
      if (channel === 'prefs:set-onboarding-permission-settings-opened') return Promise.resolve()
      if (channel === 'permissions:open-settings') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<ScreenPermissionStep onNext={vi.fn()} />)

    await userEvent.click(screen.getByText('Enable Screen Recording'))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'prefs:set-onboarding-permission-settings-opened',
        'screen',
        true,
      )
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:open-settings', 'screen')
  })

  it('opens System Settings only when the user clicks the recovery link', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'prefs:get-onboarding-permission-settings-opened') return Promise.resolve(true)
      if (channel === 'permissions:check') return Promise.resolve({ microphone: false, screen: false })
      if (channel === 'recording:get-sources') return Promise.resolve([{ id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }])
      if (channel === 'permissions:open-settings') return Promise.resolve()
      return Promise.resolve({})
    })

    render(<ScreenPermissionStep onNext={vi.fn()} />)

    await userEvent.click(await screen.findByText('Open Settings again'))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('permissions:open-settings', 'screen')
  })
})
