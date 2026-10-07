import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MeetingLanguageCode,
  WindowsMeetingLanguageAvailabilityInfo
} from '../../../shared/meeting-language'
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

  it('shows the video watermark by default and persists the playback preference', async () => {
    const state = {
      videoWatermarkVisible: true
    }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'prefs:get-video-watermark-visible': () => state.videoWatermarkVisible,
      'prefs:set-video-watermark-visible': (visible: boolean) => {
        state.videoWatermarkVisible = visible
      },
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    const user = userEvent.setup()
    const view = render(<Settings />)
    const toggle = await screen.findByRole('button', {
      name: /show autodoc watermark on recorded video/i
    })

    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
    })

    view.unmount()
    render(<Settings />)

    expect(
      await screen.findByRole('button', {
        name: /show autodoc watermark on recorded video/i
      })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('defaults the meeting language to English and persists a new default', async () => {
    const state = { meetingLanguage: 'en' }

    installMockElectronApi({
      'app:get-version': '0.1.11',
      'updater:get-status': createUpdateStatus(),
      'app:get-runtime-info': createRuntimeInfo(),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'prefs:get-meeting-language': () => state.meetingLanguage,
      'prefs:set-meeting-language': (language: string) => {
        state.meetingLanguage = language
      },
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    const user = userEvent.setup()
    const view = render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(screen.getByRole('option', { name: 'German' }))

    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()
    expect(state.meetingLanguage).toBe('de')

    view.unmount()
    render(<Settings />)

    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()
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

  it('does not render QA simulator controls in the production renderer build', async () => {
    installMockElectronApi({
      'app:get-version': '1.1.1',
      'updater:get-status': createUpdateStatus(),
      // Even a forged runtime response cannot opt a production renderer into the
      // compile-time-only simulator module.
      'app:get-runtime-info': createRuntimeInfo({ qaBuild: true, buildChannel: 'qa' }),
      'app:get-storage-info': createStorageInfo(),
      'prefs:get-analytics-consent': false,
      'prefs:get-diagnostic-log-upload-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<Settings />)

    await screen.findByText('Analytics & Crash Reports')
    expect(
      screen.queryByRole('region', { name: 'Feedback prompt simulator' })
    ).not.toBeInTheDocument()
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

  it.each(['parakeet-gpu', 'parakeet-cpu'] as const)(
    'uses automatic transcription without manual controls on Windows %s',
    async (transcriptionBackend) => {
      const api = installMockElectronApi({
        'app:get-version': '1.1.0-internal.4',
        'updater:get-status': createUpdateStatus(),
        'app:get-runtime-info': createRuntimeInfo({ platform: 'win32', transcriptionBackend }),
        'app:get-storage-info': createStorageInfo(),
        'prefs:get-analytics-consent': false,
        'prefs:get-diagnostic-log-upload-consent': false,
        'calendar:get-accounts': [],
        'calendar:get-events': []
      })
      render(<Settings />)
      expect(await screen.findByText('ggml-base.en.bin')).toBeInTheDocument()
      expect(screen.queryByText('Transcription quality')).not.toBeInTheDocument()
      expect(screen.queryByText('System impact')).not.toBeInTheDocument()
      expect(
        api.invoke.mock.calls.some(([channel]) => channel.startsWith('prefs:get-transcription-'))
      ).toBe(false)
    }
  )
})

const FIRST_USE_DOWNLOAD_BYTES = 6_012_954_214

describe('Settings Mac meeting languages', () => {
  beforeEach(() => resetRendererStores())

  function macSettingsApi(
    saved: MeetingLanguageCode = 'en',
    ensure?: (language: MeetingLanguageCode) => Promise<void>
  ) {
    const state = { language: saved }
    const api = installMockElectronApi({
      'app:get-runtime-info': createRuntimeInfo({ platform: 'darwin' }),
      'updater:get-status': createUpdateStatus(),
      'calendar:get-accounts': [],
      'prefs:get-meeting-language': () => state.language,
      'prefs:set-meeting-language': (language: MeetingLanguageCode) => {
        state.language = language
      },
      'whisper:get-meeting-language-states': {
        de: { availability: 'available', reason: null, firstUseDownloadBytes: 1_139_437_167 }
      },
      'whisper:prepare-meeting-language': (language: MeetingLanguageCode) => ensure?.(language)
    })
    return { api, state }
  }

  it('shows the Mac model size and saves only after the download succeeds', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { api, state } = macSettingsApi('en', () => pending)
    render(<Settings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await userEvent.click(await screen.findByRole('option', { name: /German.*1.1 GB/ }))
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'de')
    )
    expect(state.language).toBe('en')
    expect(api.invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
    act(() => api.emit('whisper:setup-progress', { phase: 'downloading-model', percent: 42 }))
    expect(await screen.findByText(/42%/)).toBeInTheDocument()
    await act(async () => {
      finish()
      await pending
    })
    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()
    expect(state.language).toBe('de')
  })

  it('keeps the previous language on an offline download failure', async () => {
    const { api, state } = macSettingsApi('en', async () => {
      throw new Error('Download failed: offline. Try again when connected.')
    })
    render(<Settings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await userEvent.click(await screen.findByRole('option', { name: /German/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(state.language).toBe('en')
    expect(api.invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
    expect(screen.getByRole('button', { name: 'Meeting language: English' })).toBeEnabled()
  })

  it('prepares English before saving on a fresh non-English install', async () => {
    const { api, state } = macSettingsApi('de')
    render(<Settings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Meeting language: German' }))
    await userEvent.click(await screen.findByRole('option', { name: /^English/ }))
    expect(
      await screen.findByRole('button', { name: 'Meeting language: English' })
    ).toBeInTheDocument()
    expect(state.language).toBe('en')
    expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'en')
    expect(
      api.invoke.mock.calls.findIndex(([channel]) => channel === 'whisper:prepare-meeting-language')
    ).toBeLessThan(
      api.invoke.mock.calls.findIndex(([channel]) => channel === 'prefs:set-meeting-language')
    )
  })

  it('lets a saved language download again when its files are missing', async () => {
    const { api } = macSettingsApi('de')
    render(<Settings />)
    await userEvent.click(await screen.findByRole('button', { name: 'Meeting language: German' }))
    await userEvent.click(await screen.findByRole('option', { name: /German/ }))
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'de')
    )
  })
})

function windowsLanguageInfo(
  overrides: Partial<WindowsMeetingLanguageAvailabilityInfo> = {}
): WindowsMeetingLanguageAvailabilityInfo {
  return {
    availability: 'available',
    reason: null,
    engineId: 'canary-cpu',
    firstUseDownloadBytes: 0,
    needsSelfTest: false,
    ...overrides
  }
}

describe('Settings Windows meeting languages', () => {
  beforeEach(() => {
    resetRendererStores()
  })

  function installWindowsSettingsApi(options?: {
    meetingLanguage?: MeetingLanguageCode
    languages?: Partial<Record<MeetingLanguageCode, WindowsMeetingLanguageAvailabilityInfo>>
    ensure?: (language: MeetingLanguageCode) => Promise<unknown> | unknown
  }) {
    const state = { meetingLanguage: options?.meetingLanguage ?? ('en' as MeetingLanguageCode) }
    const languages = options?.languages ?? {}
    return {
      state,
      api: installMockElectronApi({
        'app:get-version': '1.3.0',
        'updater:get-status': createUpdateStatus(),
        'app:get-runtime-info': createRuntimeInfo({ platform: 'win32' }),
        'app:get-storage-info': createStorageInfo(),
        'prefs:get-analytics-consent': false,
        'prefs:get-diagnostic-log-upload-consent': false,
        'prefs:get-meeting-language': () => state.meetingLanguage,
        'prefs:set-meeting-language': (language: MeetingLanguageCode) => {
          state.meetingLanguage = language
        },
        'whisper:get-windows-meeting-language-availability': (language: MeetingLanguageCode) =>
          languages[language] ?? windowsLanguageInfo(),
        // Main runs the engine setup and throws the reason when it is locked.
        'whisper:prepare-meeting-language': async (language: MeetingLanguageCode) => {
          const ready = await (options?.ensure
            ? options.ensure(language)
            : { engineId: 'canary-cpu', availability: 'available', reason: null })
          if (ready.availability === 'locked' || !ready.engineId) {
            throw new Error(ready.reason ?? 'Failed to download the speech model.')
          }
          return undefined
        },
        'calendar:get-accounts': [],
        'calendar:get-events': []
      })
    }
  }

  it('shows a slower note and keeps the language selectable', async () => {
    const user = userEvent.setup()
    installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ availability: 'slower' }) }
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    expect(screen.getByRole('option', { name: /German\s+Slower on this PC/ })).not.toHaveAttribute(
      'aria-disabled'
    )
  })

  it('disables a locked language and shows the returned reason', async () => {
    const user = userEvent.setup()
    const reason = 'Spanish needs a supported graphics card on this PC.'
    installWindowsSettingsApi({
      languages: { es: windowsLanguageInfo({ availability: 'locked', reason, engineId: null }) }
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    const spanish = await screen.findByRole('option', { name: new RegExp(`Spanish\\s+${reason}`) })
    expect(spanish).toHaveAttribute('aria-disabled', 'true')
    await user.click(spanish)
    expect(screen.getByRole('button', { name: 'Meeting language: English' })).toBeInTheDocument()
  })

  it('shows the first-use download size on picker rows before a language is selected', async () => {
    const user = userEvent.setup()
    installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) }
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    expect(
      await screen.findByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    ).toBeInTheDocument()
  })

  it('shows the first-use download size and hides it when the size is 0', async () => {
    const user = userEvent.setup()
    const { api } = installWindowsSettingsApi({
      meetingLanguage: 'de',
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) }
    })
    const view = render(<Settings />)

    expect(await screen.findByText('About 5.6 GB download on first use')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Meeting language: German' }))
    expect(
      screen.getByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    ).toBeInTheDocument()

    view.unmount()
    api.setHandler('whisper:get-windows-meeting-language-availability', () =>
      windowsLanguageInfo({ firstUseDownloadBytes: 0 })
    )
    render(<Settings />)

    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/download on first use/i)).not.toBeInTheDocument()
  })

  it('downloads on first use, shows progress, and saves the language', async () => {
    const user = userEvent.setup()
    let finishEnsure!: (value: unknown) => void
    const ensurePromise = new Promise((resolve) => {
      finishEnsure = resolve
    })
    const { state, api } = installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) },
      ensure: () => ensurePromise
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    expect(
      await screen.findByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    )

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'de')
    })
    await waitFor(() => {
      expect(api.on).toHaveBeenCalledWith('whisper:setup-progress', expect.any(Function))
    })
    expect(state.meetingLanguage).toBe('en')

    act(() => {
      api.emit('whisper:setup-progress', {
        phase: 'downloading-model',
        percent: 42
      })
    })
    expect(await screen.findByText('Downloading speech model... 42%')).toBeInTheDocument()

    await act(async () => {
      finishEnsure({ engineId: 'canary-cpu', availability: 'available', reason: null })
      await ensurePromise
    })

    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()
    expect(state.meetingLanguage).toBe('de')
    expect(api.invoke).toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
  })

  it('explains an offline first-use download and keeps the previous language', async () => {
    const user = userEvent.setup()
    const { state, api } = installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) },
      ensure: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'whisper:prepare-meeting-language': TypeError: fetch failed"
          )
        )
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(
      await screen.findByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You're offline. Connect to the internet to download the German speech model (about 5.6 GB). Your meeting language is still English."
    )
    expect(state.meetingLanguage).toBe('en')
    expect(api.invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
  })

  it('keeps the previous language when the first-use download fails', async () => {
    const user = userEvent.setup()
    const { state, api } = installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) },
      ensure: () => Promise.reject(new Error('Disk is full.'))
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(
      await screen.findByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full.')
    expect(screen.getByRole('button', { name: 'Meeting language: English' })).toBeInTheDocument()
    expect(state.meetingLanguage).toBe('en')
    expect(api.invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'de')
  })

  it('refreshes availability after a GPU fallback so the language can show as slower', async () => {
    const user = userEvent.setup()
    const { api } = installWindowsSettingsApi({
      languages: { de: windowsLanguageInfo({ firstUseDownloadBytes: FIRST_USE_DOWNLOAD_BYTES }) },
      ensure: () => ({
        engineId: 'canary-cpu',
        availability: 'slower',
        reason: null,
        fallbackFrom: 'canary-cuda'
      })
    })
    api.setHandler(
      'whisper:get-windows-meeting-language-availability',
      (language: MeetingLanguageCode) => {
        const ensureCalls = api.invoke.mock.calls.filter(
          ([channel]) => channel === 'whisper:prepare-meeting-language'
        )
        if (language === 'de' && ensureCalls.length > 0) {
          return windowsLanguageInfo({ availability: 'slower', firstUseDownloadBytes: 0 })
        }
        return windowsLanguageInfo({
          availability: 'available',
          firstUseDownloadBytes: language === 'de' ? FIRST_USE_DOWNLOAD_BYTES : 0
        })
      }
    )
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(
      await screen.findByRole('option', { name: /German\s+About 5\.6 GB download on first use/ })
    )

    expect(
      await screen.findByRole('button', { name: 'Meeting language: German' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Meeting language: German' }))
    expect(
      await screen.findByRole('option', { name: /German\s+Slower on this PC/ })
    ).toBeInTheDocument()
  })

  it('runs ensure for an untested GPU self-test and keeps the previous language when locked', async () => {
    const user = userEvent.setup()
    const reason = 'Spanish needs a supported graphics card on this PC.'
    const { state, api } = installWindowsSettingsApi({
      languages: {
        es: windowsLanguageInfo({
          availability: 'available',
          engineId: 'whisper-turbo-cuda',
          firstUseDownloadBytes: 0,
          needsSelfTest: true
        })
      },
      ensure: () => ({
        engineId: null,
        availability: 'locked',
        reason
      })
    })
    api.setHandler(
      'whisper:get-windows-meeting-language-availability',
      (language: MeetingLanguageCode) => {
        const ensureCalls = api.invoke.mock.calls.filter(
          ([channel]) => channel === 'whisper:prepare-meeting-language'
        )
        if (language === 'es' && ensureCalls.length > 0) {
          return windowsLanguageInfo({
            availability: 'locked',
            reason,
            engineId: null,
            needsSelfTest: false
          })
        }
        return windowsLanguageInfo({
          availability: 'available',
          engineId: 'whisper-turbo-cuda',
          firstUseDownloadBytes: 0,
          needsSelfTest: language === 'es'
        })
      }
    )
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(await screen.findByRole('option', { name: 'Spanish' }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'es')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(reason)
    expect(screen.getByRole('button', { name: 'Meeting language: English' })).toBeInTheDocument()
    expect(state.meetingLanguage).toBe('en')
    expect(api.invoke).not.toHaveBeenCalledWith('prefs:set-meeting-language', 'es')

    await user.click(screen.getByRole('button', { name: 'Meeting language: English' }))
    const spanish = await screen.findByRole('option', { name: new RegExp(`Spanish\\s+${reason}`) })
    expect(spanish).toHaveAttribute('aria-disabled', 'true')
  })

  it('saves the language when an untested GPU self-test passes', async () => {
    const user = userEvent.setup()
    const { state, api } = installWindowsSettingsApi({
      languages: {
        es: windowsLanguageInfo({
          availability: 'available',
          engineId: 'whisper-turbo-cuda',
          firstUseDownloadBytes: 0,
          needsSelfTest: true
        })
      },
      ensure: () => ({
        engineId: 'whisper-turbo-cuda',
        availability: 'available',
        reason: null
      })
    })
    render(<Settings />)

    await user.click(await screen.findByRole('button', { name: 'Meeting language: English' }))
    await user.click(await screen.findByRole('option', { name: 'Spanish' }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('whisper:prepare-meeting-language', 'es')
    })
    expect(
      await screen.findByRole('button', { name: 'Meeting language: Spanish' })
    ).toBeInTheDocument()
    expect(state.meetingLanguage).toBe('es')
    expect(api.invoke).toHaveBeenCalledWith('prefs:set-meeting-language', 'es')
  })
})
