import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackEvent } from '../../services/analytics'
import { OnboardingSupportLink } from './OnboardingSupportLink'

vi.mock('../../services/analytics', () => ({
  trackEvent: vi.fn()
}))

beforeEach(() => {
  vi.mocked(trackEvent).mockReset()
  vi.mocked(window.electronAPI.invoke).mockReset()
})

describe('OnboardingSupportLink', () => {
  it('only renders when support is available', async () => {
    vi.mocked(window.electronAPI.invoke).mockResolvedValueOnce(false)

    const { rerender } = render(<OnboardingSupportLink />)

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('support:get-availability')
    })
    expect(screen.queryByRole('button', { name: 'Email Us' })).not.toBeInTheDocument()

    vi.mocked(window.electronAPI.invoke).mockReset().mockResolvedValueOnce(true)
    rerender(<></>)
    rerender(<OnboardingSupportLink />)

    expect(await screen.findByRole('button', { name: 'Email Us' })).toBeInTheDocument()
    expect(screen.getByText('Need help?')).toBeInTheDocument()
  })

  it('opens one main-owned support request and reports its analytics outcome', async () => {
    let resolveOpen: ((value: { status: 'opened' }) => void) | undefined
    const pendingOpen = new Promise<{ status: 'opened' }>((resolve) => {
      resolveOpen = resolve
    })
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'support:get-availability') return Promise.resolve(true)
      if (channel === 'support:open-email') return pendingOpen
      return Promise.resolve({} as never)
    })

    render(<OnboardingSupportLink />)

    const emailButton = await screen.findByRole('button', { name: 'Email Us' })
    fireEvent.click(emailButton)
    fireEvent.click(emailButton)

    expect(
      vi
        .mocked(window.electronAPI.invoke)
        .mock.calls.filter(([channel]) => channel === 'support:open-email')
    ).toEqual([['support:open-email', 'onboarding']])
    expect(trackEvent).toHaveBeenCalledWith('support_email_requested', {
      surface: 'onboarding'
    })

    resolveOpen?.({ status: 'opened' })

    expect(await screen.findByText('Draft opened in your email app.')).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'onboarding',
      outcome: 'draft_opened'
    })
  })

  it('copies through main when an email app cannot be opened', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'support:get-availability') return Promise.resolve(true)
      if (channel === 'support:open-email') {
        return Promise.resolve({ status: 'copy-required', address: 'support@example.test' })
      }
      if (channel === 'support:copy-email') return Promise.resolve({ status: 'copied' })
      return Promise.resolve({} as never)
    })

    render(<OnboardingSupportLink />)

    await userEvent.click(await screen.findByRole('button', { name: 'Email Us' }))
    expect(await screen.findByText('support@example.test')).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'onboarding',
      outcome: 'copy_required'
    })

    await userEvent.click(screen.getByRole('button', { name: 'Copy email address' }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('support:copy-email', 'onboarding')
    expect(await screen.findByText('Email address copied')).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'onboarding',
      outcome: 'address_copied'
    })
  })

  it('offers a retry after a main-owned copy failure', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'support:get-availability') return Promise.resolve(true)
      if (channel === 'support:open-email') {
        return Promise.resolve({ status: 'copy-required', address: 'support@example.test' })
      }
      if (channel === 'support:copy-email') return Promise.resolve({ status: 'copy-failed' })
      return Promise.resolve({} as never)
    })

    render(<OnboardingSupportLink />)

    await userEvent.click(await screen.findByRole('button', { name: 'Email Us' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Copy email address' }))

    expect(await screen.findByText('Couldn’t copy the address.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try copying again' })).toBeEnabled()
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'onboarding',
      outcome: 'copy_failed'
    })
  })

  it('reports an unavailable email handoff without exposing a renderer fallback', async () => {
    vi.mocked(window.electronAPI.invoke).mockImplementation((channel: string) => {
      if (channel === 'support:get-availability') return Promise.resolve(true)
      if (channel === 'support:open-email') return Promise.resolve({ status: 'unavailable' })
      return Promise.resolve({} as never)
    })

    render(<OnboardingSupportLink />)

    await userEvent.click(await screen.findByRole('button', { name: 'Email Us' }))

    expect(await screen.findByText('Email isn’t available right now.')).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'onboarding',
      outcome: 'unavailable'
    })
  })
})
