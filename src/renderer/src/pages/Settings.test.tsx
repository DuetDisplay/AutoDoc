import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings'
import {
  createCalendarAccount,
  createRuntimeInfo,
  createStorageInfo,
  createUpdateStatus,
  installMockElectronApi,
  resetRendererStores
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
      diagnosticLogUploadConsent: false
    }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'prefs:get-diagnostic-log-upload-consent': () => state.diagnosticLogUploadConsent,
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:disconnect': (accountId: string) => {
        state.accounts = state.accounts.filter((account) => account.id !== accountId)
      }
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
      diagnosticLogUploadConsent: false
    }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'prefs:get-diagnostic-log-upload-consent': () => state.diagnosticLogUploadConsent,
      'prefs:set-analytics-consent': (enabled: boolean) => {
        state.analyticsConsent = enabled
      },
      'prefs:set-diagnostic-log-upload-consent': (enabled: boolean) => {
        state.diagnosticLogUploadConsent = enabled
      },
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:connect': () => {
        state.accounts = [account]
        return account
      }
    })

    const user = userEvent.setup()
    const view = render(<Settings />)

    await user.click(screen.getByRole('button', { name: /add google calendar/i }))
    expect(await screen.findByText('team@example.com')).toBeInTheDocument()

    const analyticsToggle = screen.getByRole('button', {
      name: /toggle analytics and crash reports/i
    })
    expect(analyticsToggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(analyticsToggle)

    await waitFor(() => {
      expect(analyticsToggle).toHaveAttribute('aria-pressed', 'true')
    })

    const logUploadCheckbox = screen.getByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    expect(logUploadCheckbox).not.toBeChecked()

    await user.click(logUploadCheckbox)

    await waitFor(() => {
      expect(logUploadCheckbox).toBeChecked()
    })

    view.unmount()
    render(<Settings />)

    expect(await screen.findByText('team@example.com')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /toggle analytics and crash reports/i })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('checkbox', { name: /attach technical app logs to error reports/i })
    ).toBeChecked()
  })

  it('cancels an abandoned calendar connection when the app regains focus', async () => {
    const state = {
      accounts: [createCalendarAccount({ email: 'existing@example.com' })],
      events: [] as any[],
      analyticsConsent: false,
      diagnosticLogUploadConsent: false
    }

    const api = installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'prefs:get-diagnostic-log-upload-consent': () => state.diagnosticLogUploadConsent,
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:connect': () => new Promise(() => {}),
      'calendar:cancel-connect': undefined
    })

    const user = userEvent.setup()
    render(<Settings />)

    expect(await screen.findByText('existing@example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /add google calendar/i }))

    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add microsoft outlook/i })).toBeDisabled()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add google calendar/i })).toBeEnabled()
      expect(screen.getByRole('button', { name: /add microsoft outlook/i })).toBeEnabled()
    })
    expect(screen.queryByRole('button', { name: /connecting/i })).not.toBeInTheDocument()
    expect(api.invoke).toHaveBeenCalledWith('calendar:cancel-connect')
  })

  it('does not render the speaker diarization toggle', async () => {
    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<Settings />)

    await screen.findByText('Analytics & Crash Reports')
    expect(
      screen.queryByRole('button', { name: /toggle experimental speaker diarization/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Speaker diarization')).not.toBeInTheDocument()
  })

  it('shows an inline message for unsupported Microsoft mailboxes', async () => {
    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [
        createCalendarAccount({
          id: 'acct-microsoft',
          provider: 'microsoft',
          email: 'person@contoso.com',
          syncIssue: 'unsupported-mailbox'
        })
      ],
      'calendar:get-events': []
    })

    render(<Settings />)

    expect(await screen.findByText('person@contoso.com')).toBeInTheDocument()
    expect(
      screen.getByText('Calendar sync is unavailable for this Microsoft mailbox type.')
    ).toBeInTheDocument()
  })

  it('shows an inline message when a Microsoft account needs to be reconnected', async () => {
    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [
        createCalendarAccount({
          id: 'acct-microsoft',
          provider: 'microsoft',
          email: 'person@contoso.com',
          syncIssue: 'reconnect-required'
        })
      ],
      'calendar:get-events': []
    })

    render(<Settings />)

    expect(await screen.findByText('person@contoso.com')).toBeInTheDocument()
    expect(
      screen.getByText('Microsoft Outlook needs to be reconnected to resume calendar sync.')
    ).toBeInTheDocument()
  })

  it('removes downloaded AI components from settings', async () => {
    let storageInfo = createStorageInfo()

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': () => storageInfo,
      'app:clear-downloaded-components': () => {
        storageInfo = createStorageInfo({
          downloadedComponentsBytes: 0,
          totalBytes: storageInfo.totalBytes - storageInfo.downloadedComponentsBytes
        })
        return storageInfo
      },
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    render(<Settings />)

    expect(await screen.findByText('Downloaded AI components')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /remove downloaded ai components/i }))

    expect(await screen.findByText(/downloaded ai components removed/i)).toBeInTheDocument()
    expect(screen.getByText('0 B')).toBeInTheDocument()

    confirmSpy.mockRestore()
  })

  it('starts a full local reset from settings after confirmation', async () => {
    const api = installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'app:reset-local-data': undefined,
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    render(<Settings />)

    await screen.findByText('Downloaded AI components')
    await user.click(screen.getByRole('button', { name: /delete all local autodoc data/i }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('app:reset-local-data')
    })
    expect(screen.getByText(/restarting autodoc and clearing local data/i)).toBeInTheDocument()

    confirmSpy.mockRestore()
  })
})
