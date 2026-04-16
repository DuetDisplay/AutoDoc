import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { Settings } from './Settings'
import {
  createCalendarAccount,
  createRuntimeInfo,
  createUpdateStatus,
  installMockElectronApi,
  resetRendererStores,
} from '../test/fixtures'

describe('Settings', () => {
  beforeEach(() => {
    resetRendererStores()
  })

  it('disconnects a calendar and persists that disconnected state after reload', async () => {
    const state = {
      accounts: [createCalendarAccount()],
      events: [] as any[],
      analyticsConsent: false,
    }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:disconnect': (accountId: string) => {
        state.accounts = state.accounts.filter((account) => account.id !== accountId)
      },
    })

    const user = userEvent.setup()
    const view = render(<Settings />)

    expect(await screen.findByText('team@example.com')).toBeInTheDocument()
    expect(screen.getByText('/tmp/autodoc-tests')).toBeInTheDocument()
    expect(screen.getByText('ggml-base.en.bin')).toBeInTheDocument()
    expect(screen.getByText('llama3.2:3b')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(screen.queryByText('team@example.com')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /add google calendar/i })).toBeInTheDocument()
    })

    view.unmount()
    render(<Settings />)

    await waitFor(() => {
      expect(screen.queryByText('team@example.com')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /add google calendar/i })).toBeInTheDocument()
    })
  })

  it('reconnects a calendar and persists analytics consent after reload', async () => {
    const account = createCalendarAccount()
    const state = {
      accounts: [] as ReturnType<typeof createCalendarAccount>[],
      events: [] as any[],
      analyticsConsent: false,
    }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'prefs:set-analytics-consent': (enabled: boolean) => {
        state.analyticsConsent = enabled
      },
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:connect': () => {
        state.accounts = [account]
        return account
      },
    })

    const user = userEvent.setup()
    const view = render(<Settings />)

    await user.click(screen.getByRole('button', { name: /add google calendar/i }))
    expect(await screen.findByText('team@example.com')).toBeInTheDocument()

    const analyticsToggle = screen.getByRole('button', {
      name: /toggle analytics and crash reports/i,
    })
    expect(analyticsToggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(analyticsToggle)

    await waitFor(() => {
      expect(analyticsToggle).toHaveAttribute('aria-pressed', 'true')
    })

    view.unmount()
    render(<Settings />)

    expect(await screen.findByText('team@example.com')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /toggle analytics and crash reports/i }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
})
