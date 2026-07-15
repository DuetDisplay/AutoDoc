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

  it('keeps connecting while in the browser, clears it on return, and still surfaces a late success', async () => {
    const existing = createCalendarAccount({
      id: 'acct-existing',
      email: 'existing@example.com',
      connectedAt: new Date('2026-04-16T09:00:00Z').getTime()
    })
    const connectedAccount = createCalendarAccount({ id: 'acct-new', email: 'new@example.com' })
    const state = {
      accounts: [existing] as ReturnType<typeof createCalendarAccount>[],
      events: [] as any[],
      analyticsConsent: false,
      diagnosticLogUploadConsent: false
    }
    let resolveConnect!: (account: typeof connectedAccount) => void
    const connectPromise = new Promise<typeof connectedAccount>((resolve) => {
      resolveConnect = resolve
    })

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': () => state.analyticsConsent,
      'prefs:get-diagnostic-log-upload-consent': () => state.diagnosticLogUploadConsent,
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      // The OAuth flow is still in the external browser — the IPC hasn't resolved yet.
      'calendar:connect': () => connectPromise
    })

    const user = userEvent.setup()
    render(<Settings />)

    expect(await screen.findByText('existing@example.com')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /add google calendar/i }))
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled()

    // Handing off to the OAuth browser (window `blur`) must NOT flip the button back —
    // doing so caused a click-time flash. It stays "Connecting".
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(screen.getByRole('button', { name: /connecting/i })).toBeDisabled()

    // Returning to the app (window `focus`) clears the disabled state so an abandoned
    // attempt can be retried.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add google calendar/i })).toBeEnabled()
      expect(screen.getByRole('button', { name: /add microsoft outlook/i })).toBeEnabled()
    })
    expect(screen.queryByRole('button', { name: /connecting/i })).not.toBeInTheDocument()

    // The user actually finished in the browser, so the awaited connection still
    // resolves and surfaces the account even though we cleared the display on return.
    state.accounts = [existing, connectedAccount]
    await act(async () => {
      resolveConnect(connectedAccount)
      await connectPromise
    })

    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
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

  it('shows Restarting immediately after starting an update install', async () => {
    const api = installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus({ state: 'downloaded', version: '0.1.47' }),
      'updater:install': undefined,
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    const user = userEvent.setup()
    render(<Settings />)

    const restartButton = await screen.findByRole('button', {
      name: 'Restart to update to v0.1.47'
    })

    await user.click(restartButton)

    expect(restartButton).toHaveTextContent('Restarting...')
    expect(restartButton).toBeDisabled()
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('updater:install')
    })
  })

  it('shows transcription quality controls only for Parakeet GPU on Windows', async () => {
    installMockElectronApi({
      'app:get-version': '1.1.0-internal.3',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo({
        platform: 'win32',
        transcriptionBackend: 'parakeet-gpu'
      }),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'prefs:get-transcription-quality-mode': 'balanced',
      'prefs:get-transcription-performance-mode': 'balanced',
      'whisper:get-setup-status': {
        phase: 'ready',
        percent: 100,
        backend: 'parakeet-gpu'
      },
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<Settings />)

    expect(await screen.findByText('Transcription quality')).toBeInTheDocument()
    expect(screen.getByText('System impact')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Balanced gives the most accurate transcripts. Fast uses a smaller, more efficient model that may be slightly less accurate.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Smaller model, lighter on memory. May be slightly less accurate; speed varies by hardware.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Noticeably faster/i)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        /On GPU-accelerated transcription this setting has little effect\./
      )
    ).toBeInTheDocument()
  })

  it('hides transcription quality controls on Windows CPU Parakeet tiers', async () => {
    installMockElectronApi({
      'app:get-version': '1.1.0-internal.3',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo({
        platform: 'win32',
        transcriptionBackend: 'parakeet-cpu'
      }),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'prefs:get-transcription-quality-mode': 'balanced',
      'prefs:get-transcription-performance-mode': 'balanced',
      'whisper:get-setup-status': {
        phase: 'ready',
        percent: 100,
        backend: 'parakeet-cpu'
      },
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<Settings />)

    await screen.findByText('System impact')
    expect(screen.queryByText('Transcription quality')).not.toBeInTheDocument()
  })
})
