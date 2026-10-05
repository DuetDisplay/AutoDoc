import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MeetingLanguageStep } from '../MeetingLanguageStep'
import { Settings } from '../../../pages/Settings'
import {
  meetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../../../../shared/meeting-language'
import { createRuntimeInfo, resetRendererStores } from '../../../test/fixtures'

let saved: MeetingLanguageCode
beforeEach(() => {
  resetRendererStores()
  saved = 'en'
  vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === 'prefs:get-meeting-language') return Promise.resolve(saved)
    if (channel === 'prefs:set-meeting-language') {
      saved = args[0] as MeetingLanguageCode
      return Promise.resolve()
    }
    if (channel === 'prefs:get-onboarding-language-confirmed') return Promise.resolve(false)
    if (channel === 'prefs:get-meeting-language-availability')
      return Promise.resolve(meetingLanguageAvailability(false))
    if (channel === 'whisper:get-meeting-language-states')
      return Promise.resolve({
        fr: { availability: 'available', reason: null, firstUseDownloadBytes: 1139437167 }
      })
    if (channel === 'app:get-locale') return Promise.resolve('fr-FR')
    if (channel === 'app:get-runtime-info') return Promise.resolve(createRuntimeInfo())
    if (channel === 'updater:get-status') return Promise.resolve({ state: 'idle' })
    if (channel === 'calendar:get-accounts') return Promise.resolve([])
    return Promise.resolve(null as never)
  })
})

describe('MeetingLanguageStep', () => {
  it('defaults to the available OS language and persists the same preference Settings reads', async () => {
    const next = vi.fn()
    const view = render(<MeetingLanguageStep onNext={next} />)
    expect(
      await screen.findByRole('button', { name: 'Meeting language: French' })
    ).toBeInTheDocument()
    expect(screen.getByText(/download on first use/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(saved).toBe('fr')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:confirm-onboarding-language')
    expect(next).toHaveBeenCalledOnce()
    view.unmount()
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: 'Meeting language: French' })
    ).toBeInTheDocument()
  })

  it('does not advance when preference persistence is rejected', async () => {
    const invoke = vi.mocked(window.electronAPI.invoke).getMockImplementation()!
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel, ...args) => {
      if (channel === 'prefs:set-meeting-language') return Promise.reject(new Error('Needs 16 GB'))
      return invoke(channel, ...args)
    })
    const next = vi.fn()
    render(<MeetingLanguageStep onNext={next} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Needs 16 GB')
    expect(next).not.toHaveBeenCalled()
    expect(saved).toBe('en')
  })
})
