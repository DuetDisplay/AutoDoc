import { I18nProvider } from './services/i18n'
import { translate, type MessageKey } from '../../shared/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { useRecordingPickerStore } from './stores/recording-picker'
import { shouldLogRendererDiagnosticToAppLog } from '../../shared/diagnostics'
import {
  createCalendarAccount,
  createCalendarEvent,
  createRecordingEntry,
  createUpdateStatus,
  installMockElectronApi,
  resetRendererStores
} from './test/fixtures'

const recordingMocks = vi.hoisted(() => ({
  fetchSources: vi.fn(
    async () => [] as Array<{ id: string; name: string; thumbnailDataUrl: string }>
  ),
  handleStart: vi.fn()
}))

vi.mock('./hooks/useRecording', () => ({
  useRecording: () => ({
    isRecording: false,
    sourceName: null,
    elapsedSeconds: 0,
    handleStop: vi.fn(),
    fetchSources: recordingMocks.fetchSources,
    handleStart: recordingMocks.handleStart
  }),
  useRecordingActions: () => ({
    isRecording: false,
    fetchSources: vi.fn(),
    handleStart: vi.fn(),
    handleStop: vi.fn()
  })
}))

vi.mock('./components/Sidebar', () => ({
  Sidebar: () => <div>Sidebar</div>
}))

vi.mock('./components/RecordingBanner', () => ({
  RecordingBanner: () => null
}))

vi.mock('./components/MeetingDetectedBanner', () => ({
  MeetingDetectedBanner: () => null
}))

vi.mock('./components/PermissionToast', () => ({
  PermissionToast: () => null
}))

/** Advances fake timers and flushes the promises the auto-record wait loop is awaiting. */
async function advanceAutoRecordWait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('App', () => {
  beforeEach(() => {
    resetRendererStores()
    useRecordingPickerStore.getState().closePicker()
    recordingMocks.fetchSources.mockReset().mockResolvedValue([])
    recordingMocks.handleStart.mockReset()
    window.location.hash = '#/'
  })

  afterEach(() => {
    window.location.hash = '#/'
    vi.useRealTimers()
  })

  it('shows onboarding when the first-run flow is not complete yet', async () => {
    installMockElectronApi({
      'prefs:get-onboarding-complete': false,
      'prefs:get-analytics-consent': null,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<App />)

    expect(await screen.findByText('Choose your language')).toBeInTheDocument()
  })

  it('skips onboarding and renders the app shell for returning users', async () => {
    installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<App />)

    expect(await screen.findByText('Sidebar')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()
  })

  it('reacts to a calendar disconnect and returns Upcoming to the connect state', async () => {
    const state = {
      accounts: [createCalendarAccount()],
      events: [createCalendarEvent()]
    }

    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events
    })

    render(<App />)

    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()

    state.accounts = []
    state.events = []
    act(() => {
      api.emit('calendar:connection-changed', false)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect google calendar/i })).toBeInTheDocument()
    })
  })

  it('requests a visible fallback before opening an ambiguous auto-record picker', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [createCalendarAccount()],
      'calendar:get-events': [createCalendarEvent({ id: 'all-day', isAllDay: true })]
    })
    recordingMocks.fetchSources.mockResolvedValue([
      { id: 'window:1', name: 'Jamal - Duet Display - Slack', thumbnailDataUrl: '' },
      { id: 'window:2', name: 'Jamal - Other Workspace - Slack', thumbnailDataUrl: '' }
    ])
    render(<App />)
    await screen.findByRole('heading', { name: 'Upcoming' })
    const payload = {
      requestId: 7,
      providerId: 'slack',
      hasCalendarEvent: true,
      eventId: 'timed',
      recurringEventId: 'timed-series'
    }
    vi.useFakeTimers()
    act(() => api.emit('detection:auto-record', payload))
    // Slack keeps looking for a meeting window before it asks the user to pick one.
    await advanceAutoRecordWait(1_000)
    expect(api.invoke).not.toHaveBeenCalledWith('detection:source-selection-required', 7)
    await advanceAutoRecordWait(30_000)
    expect(api.invoke).toHaveBeenCalledWith('detection:source-selection-required', 7)
    vi.useRealTimers()
    expect(useRecordingPickerStore.getState().isOpen).toBe(false)
    expect(recordingMocks.handleStart).not.toHaveBeenCalled()
    expect(api.invoke).not.toHaveBeenCalledWith('detection:auto-record-started', expect.anything())
    const decision = api.invoke.mock.calls.find(
      ([channel, logged]) =>
        channel === 'diagnostics:record-action' && logged?.action === 'auto_record_decision'
    )?.[1]
    expect(decision).toMatchObject({
      category: 'recording',
      details: {
        requestId: 7,
        outcome: 'selection_required',
        attempt: 1,
        waitingForMeetingWindow: true,
        hasCalendarEvent: true,
        providerHint: 'slack',
        selectionConfidence: 'none',
        windowCount: 2,
        meetingWindowCount: 2,
        bestScore: 160,
        secondBestScore: 160
      }
    })
    expect(JSON.stringify(decision)).not.toContain('Jamal')
    act(() => api.emit('detection:select-window', payload))
    await waitFor(() => expect(useRecordingPickerStore.getState().isOpen).toBe(true))
    expect(useRecordingPickerStore.getState()).toMatchObject({
      trigger: 'auto_record',
      selectionContext: {
        eventId: 'timed',
        recurringEventId: 'timed-series',
        providerHint: 'slack'
      }
    })
  })

  it('logs the QA scenario decision, picker opening and start outcomes without any titles', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [createCalendarAccount()],
      'calendar:get-events': [createCalendarEvent({ id: 'timed', title: 'Testing Autodoc' })]
    })
    recordingMocks.fetchSources.mockResolvedValue([
      { id: 'window:1', name: 'Jamal - Duet Display - Slack', thumbnailDataUrl: '' },
      { id: 'window:2', name: 'Jamal - Other Workspace - Slack', thumbnailDataUrl: '' },
      { id: 'screen:0', name: 'Testing Autodoc', thumbnailDataUrl: '' }
    ])
    render(<App />)
    await screen.findByRole('heading', { name: 'Upcoming' })
    const payload = {
      requestId: 7,
      providerId: 'slack',
      hasCalendarEvent: true,
      eventId: 'timed',
      recurringEventId: null
    }
    vi.useFakeTimers()
    act(() => api.emit('detection:auto-record', payload))
    await advanceAutoRecordWait(31_000)
    expect(api.invoke).toHaveBeenCalledWith('detection:source-selection-required', 7)
    vi.useRealTimers()
    act(() => api.emit('detection:select-window', payload))
    await waitFor(() => expect(useRecordingPickerStore.getState().isOpen).toBe(true))
    expect(useRecordingPickerStore.getState()).toMatchObject({
      requestId: 7,
      diagnosticTrigger: 'select_window',
      scoredSourceIds: ['window:1', 'window:2']
    })

    const recorded = (): Array<{ action: string; details: Record<string, unknown> }> =>
      api.invoke.mock.calls
        .filter(([channel]) => channel === 'diagnostics:record-action')
        .map(([, logged]) => logged)
    const decision = recorded().find((entry) => entry.action === 'auto_record_decision')!
    expect(decision.details).toMatchObject({
      eventId: 'timed',
      chosenIndex: null,
      candidates: [
        expect.objectContaining({ sourceType: 'window', score: 160, providerHintMatch: true }),
        expect.objectContaining({ sourceType: 'window', score: 160, meetingPattern: true })
      ]
    })
    expect(recorded().find((entry) => entry.action === 'recording_picker_opened')).toMatchObject({
      details: {
        trigger: 'select_window',
        requestId: 7,
        eventId: 'timed',
        sourceCount: 3,
        suggestionHighlighted: false
      }
    })

    // A confident window starts and reports the started outcome.
    recordingMocks.fetchSources.mockResolvedValue([
      { id: 'window:huddle', name: 'Huddle: Product – Slack', thumbnailDataUrl: '' }
    ])
    act(() => api.emit('detection:auto-record', { ...payload, requestId: 8 }))
    await waitFor(() =>
      expect(
        recorded().find((entry) => entry.action === 'auto_record_start_outcome')
      ).toMatchObject({
        details: { outcome: 'started', requestId: 8, eventId: 'timed' }
      })
    )
    const everything = JSON.stringify(recorded())
    expect(everything).not.toContain('Jamal')
    expect(everything).not.toContain('Testing Autodoc')
    expect(everything).not.toContain('Huddle:')
    // Every action must pass the main-process allowlist so it reaches autodocLog.
    for (const entry of recorded().filter((e) =>
      ['auto_record_decision', 'auto_record_start_outcome', 'recording_picker_opened'].includes(
        e.action
      )
    )) {
      expect(shouldLogRendererDiagnosticToAppLog({ category: 'recording', ...entry })).toBe(true)
    }
  })

  describe('waiting for a Slack meeting window', () => {
    const MAIN = 'autodoc-social-radar (Channel) - AutoDocTest - Slack [Main] 🏠'
    const PREVIEW = '- AutoDocTest - 1 new item - Slack'
    const HUDDLE = 'autodoc-social-radar - AutoDocTest - 1 new item - Slack'
    const payload = {
      requestId: 20,
      providerId: 'slack',
      hasCalendarEvent: true,
      eventId: 'timed',
      recurringEventId: null
    }
    const preJoinSources = [
      { id: 'window:main', name: MAIN, thumbnailDataUrl: '' },
      { id: 'window:preview', name: PREVIEW, thumbnailDataUrl: '' }
    ]

    const setup = async () => {
      const api = installMockElectronApi({
        'prefs:get-onboarding-complete': true,
        'prefs:get-analytics-consent': false,
        'calendar:get-accounts': [],
        'calendar:get-events': []
      })
      recordingMocks.fetchSources.mockResolvedValue(preJoinSources)
      render(<App />)
      await screen.findByRole('heading', { name: 'Upcoming' })
      vi.useFakeTimers()
      const decisions = (): Array<Record<string, any>> =>
        api.invoke.mock.calls
          .filter(
            ([channel, logged]) =>
              channel === 'diagnostics:record-action' && logged?.action === 'auto_record_decision'
          )
          .map(([, logged]) => logged.details)
      return { api, decisions }
    }

    it('does not record the main or pre-join window and starts once the huddle window appears', async () => {
      const { api, decisions } = await setup()
      act(() => api.emit('detection:auto-record', payload))
      await advanceAutoRecordWait(6_000)
      expect(recordingMocks.handleStart).not.toHaveBeenCalled()
      expect(api.invoke).not.toHaveBeenCalledWith(
        'detection:source-selection-required',
        expect.anything()
      )

      recordingMocks.fetchSources.mockResolvedValue([
        ...preJoinSources,
        { id: 'window:huddle', name: HUDDLE, thumbnailDataUrl: '' }
      ])
      await advanceAutoRecordWait(2_000)

      expect(recordingMocks.handleStart).toHaveBeenCalledTimes(1)
      expect(recordingMocks.handleStart).toHaveBeenCalledWith(
        'window:huddle',
        HUDDLE,
        { eventId: 'timed', recurringEventId: null, providerHint: 'slack' },
        expect.objectContaining({ recordingIntent: 'meeting', providerId: 'slack' })
      )
      expect(api.invoke).toHaveBeenCalledWith('detection:auto-record-started', 20)
      expect(api.invoke).not.toHaveBeenCalledWith(
        'detection:source-selection-required',
        expect.anything()
      )
      // First attempt while waiting, then only the change to a confident start.
      expect(decisions()).toMatchObject([
        { requestId: 20, outcome: 'selection_required', attempt: 1, waitingForMeetingWindow: true },
        { requestId: 20, outcome: 'auto_start', attempt: 5, waitingForMeetingWindow: false }
      ])
      expect(JSON.stringify(decisions())).not.toContain('AutoDocTest')
    })

    it('stops waiting without escalating when the mic goes inactive', async () => {
      const { api, decisions } = await setup()
      act(() => api.emit('detection:auto-record', payload))
      await advanceAutoRecordWait(4_000)
      const fetchesBefore = recordingMocks.fetchSources.mock.calls.length
      act(() => api.emit('detection:mic-inactive', {}))
      await advanceAutoRecordWait(60_000)

      expect(recordingMocks.fetchSources.mock.calls.length).toBe(fetchesBefore)
      expect(recordingMocks.handleStart).not.toHaveBeenCalled()
      expect(api.invoke).not.toHaveBeenCalledWith(
        'detection:source-selection-required',
        expect.anything()
      )
      expect(decisions().at(-1)).toMatchObject({
        requestId: 20,
        outcome: 'wait_cancelled',
        reason: 'mic_inactive'
      })

      // A later request (the user joined after all) works normally.
      recordingMocks.fetchSources.mockResolvedValue([
        { id: 'window:huddle', name: HUDDLE, thumbnailDataUrl: '' }
      ])
      act(() => api.emit('detection:auto-record', { ...payload, requestId: 21 }))
      await advanceAutoRecordWait(0)
      expect(recordingMocks.handleStart).toHaveBeenCalledTimes(1)
    })

    it('replaces the wait when a newer auto-record request arrives', async () => {
      const { api, decisions } = await setup()
      act(() => api.emit('detection:auto-record', payload))
      await advanceAutoRecordWait(4_000)
      act(() => api.emit('detection:auto-record', { ...payload, requestId: 21 }))
      await advanceAutoRecordWait(31_000)

      expect(decisions().find((d) => d.outcome === 'wait_cancelled')).toMatchObject({
        requestId: 20,
        reason: 'superseded'
      })
      expect(api.invoke).not.toHaveBeenCalledWith('detection:source-selection-required', 20)
      expect(api.invoke).toHaveBeenCalledWith('detection:source-selection-required', 21)
    })

    it('falls back to window selection after 30 seconds without a clear window', async () => {
      const { api, decisions } = await setup()
      act(() => api.emit('detection:auto-record', payload))
      await advanceAutoRecordWait(28_000)
      expect(api.invoke).not.toHaveBeenCalledWith(
        'detection:source-selection-required',
        expect.anything()
      )
      await advanceAutoRecordWait(2_000)

      expect(api.invoke).toHaveBeenCalledWith('detection:source-selection-required', 20)
      expect(recordingMocks.handleStart).not.toHaveBeenCalled()
      // One log for the first attempt and one for the final outcome, not one per tick.
      expect(decisions()).toMatchObject([
        { outcome: 'selection_required', attempt: 1, waitingForMeetingWindow: true },
        { outcome: 'selection_required', attempt: 16, waitingForMeetingWindow: false }
      ])
    })

    it('keeps the immediate behaviour for other providers', async () => {
      const { api, decisions } = await setup()
      recordingMocks.fetchSources.mockResolvedValue([
        { id: 'window:1', name: 'Zoom Meeting (Sprint)', thumbnailDataUrl: '' },
        { id: 'window:2', name: 'Zoom Workplace', thumbnailDataUrl: '' }
      ])
      act(() => api.emit('detection:auto-record', { ...payload, providerId: 'zoom' }))
      await advanceAutoRecordWait(0)

      expect(api.invoke).toHaveBeenCalledWith('detection:source-selection-required', 20)
      expect(decisions()).toMatchObject([{ attempt: 1, waitingForMeetingWindow: false }])
    })
  })

  it('logs a failed auto-record start with the request and event ids', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })
    recordingMocks.fetchSources.mockResolvedValue([
      { id: 'window:huddle', name: 'Huddle: Product – Slack', thumbnailDataUrl: '' }
    ])
    recordingMocks.handleStart.mockRejectedValueOnce(new Error('capture exploded'))
    render(<App />)
    await screen.findByRole('heading', { name: 'Upcoming' })
    act(() =>
      api.emit('detection:auto-record', {
        requestId: 9,
        providerId: 'slack',
        hasCalendarEvent: true,
        eventId: 'timed',
        recurringEventId: null
      })
    )
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith('diagnostics:record-action', {
        category: 'recording',
        action: 'auto_record_start_outcome',
        details: { outcome: 'failed', requestId: 9, eventId: 'timed', error: 'capture exploded' }
      })
    )
    expect(api.invoke).not.toHaveBeenCalledWith('detection:auto-record-started', 9)
  })

  it('starts a confidently identified meeting with the detector event even when the UI calendar differs', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })
    recordingMocks.fetchSources.mockResolvedValue([
      { id: 'window:huddle', name: 'Huddle: Product – Slack', thumbnailDataUrl: '' }
    ])
    render(<App />)
    await screen.findByRole('heading', { name: 'Upcoming' })
    act(() =>
      api.emit('detection:auto-record', {
        requestId: 3,
        providerId: 'slack',
        hasCalendarEvent: true,
        eventId: 'timed',
        recurringEventId: null
      })
    )
    await waitFor(() =>
      expect(recordingMocks.handleStart).toHaveBeenCalledWith(
        'window:huddle',
        'Huddle: Product – Slack',
        { eventId: 'timed', recurringEventId: null, providerHint: 'slack' },
        expect.objectContaining({ recordingIntent: 'meeting', providerId: 'slack' })
      )
    )
    expect(api.invoke).not.toHaveBeenCalledWith(
      'detection:source-selection-required',
      expect.anything()
    )
    await waitFor(() => expect(api.invoke).toHaveBeenCalledWith('detection:auto-record-started', 3))
    expect(api.invoke).toHaveBeenCalledWith(
      'diagnostics:record-action',
      expect.objectContaining({
        action: 'auto_record_decision',
        details: expect.objectContaining({ requestId: 3, outcome: 'auto_start' })
      })
    )
  })

  it('shows the low-memory Mac processing banner globally after the first recording', async () => {
    installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'recording:list': [createRecordingEntry()],
      'whisper:get-setup-status': {
        phase: 'ready',
        percent: 100,
        backend: 'mlx-whisper',
        backendLabel: 'Apple Silicon optimized transcription',
        macProcessingProfileId: 'mac-low-spec'
      },
      'prefs:get-low-spec-mac-processing-banner-dismissed': false,
      'prefs:set-low-spec-mac-processing-banner-dismissed': undefined
    })

    render(<App />)

    expect(await screen.findByText('Sidebar')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()
    expect(await screen.findByText('Optimized local processing is on')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Got it' }))

    await waitFor(() => {
      expect(screen.queryByText('Optimized local processing is on')).not.toBeInTheDocument()
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'prefs:set-low-spec-mac-processing-banner-dismissed',
      true
    )
  })

  it('does not show the low-memory Mac processing banner before any recordings exist', async () => {
    installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'recording:list': [],
      'whisper:get-setup-status': {
        phase: 'ready',
        percent: 100,
        backend: 'mlx-whisper',
        backendLabel: 'Apple Silicon optimized transcription',
        macProcessingProfileId: 'mac-low-spec'
      },
      'prefs:get-low-spec-mac-processing-banner-dismissed': false
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()
    expect(screen.queryByText('Optimized local processing is on')).not.toBeInTheDocument()
  })

  it('shows a disk-full update alert that can retry or be dismissed until the next failure', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus(),
      'updater:check': undefined
    })

    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()

    act(() => {
      api.emit('updater:status', createUpdateStatus({ state: 'error', error: 'boom' }))
    })
    expect(screen.queryByText('Not enough space to install the update')).not.toBeInTheDocument()

    const diskFull = createUpdateStatus({
      state: 'error',
      error: 'ENOSPC',
      errorKind: 'disk-full'
    })
    act(() => api.emit('updater:status', diskFull))
    expect(await screen.findByText('Not enough space to install the update')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Your computer is almost out of disk space. Free up some space, then try again.'
      )
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(api.invoke).toHaveBeenCalledWith('updater:check')

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Not enough space to install the update')).not.toBeInTheDocument()

    act(() => api.emit('updater:status', createUpdateStatus({ state: 'checking' })))
    act(() => api.emit('updater:status', diskFull))
    expect(await screen.findByText('Not enough space to install the update')).toBeInTheDocument()

    // Settings shows its own card, so the app-wide banner steps aside there.
    act(() => {
      window.location.hash = '#/settings'
    })
    await waitFor(() =>
      expect(screen.queryByText('Not enough space to install the update')).not.toBeInTheDocument()
    )
  })

  it('shows a restart prompt when an update is ready', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus(),
      'updater:install': undefined
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()

    act(() => {
      api.emit('updater:status', createUpdateStatus({ state: 'downloaded', version: '0.1.47' }))
    })

    expect(await screen.findByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('Restart to update to v0.1.47')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    expect(screen.getByRole('button', { name: 'Restarting...' })).toBeDisabled()
    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith('updater:install')
    })
  })

  it('keeps Restart disabled until the main process clears its recording or processing block', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus({
        state: 'downloaded',
        version: '1.3.1',
        installBlockedReason: 'Finish your recording before restarting.'
      })
    })
    render(<App />)
    const restart = await screen.findByRole('button', { name: 'Restart' })
    expect(restart).toBeDisabled()
    await userEvent.click(restart)
    expect(api.invoke).not.toHaveBeenCalledWith('updater:install')
    act(() =>
      api.emit('updater:status', createUpdateStatus({ state: 'downloaded', version: '1.3.1' }))
    )
    expect(restart).toBeEnabled()
  })

  it.each([
    ['Finish your recording before restarting.', 'settings.finishRecordingBeforeRestart'],
    ['AutoDoc is starting. Try again shortly.', 'update.startingBeforeRestart'],
    [
      'AutoDoc is processing your meeting. Restart when it finishes.',
      'update.processingBeforeRestart'
    ],
    ['Wait for the model download to finish before restarting.', 'update.downloadBeforeRestart'],
    ['AutoDoc is saving your recording.', 'update.savingBeforeRestart']
  ] as const)(
    'localizes a visible restart block and preserves its guard: %s',
    async (reason, key: MessageKey) => {
      const api = installMockElectronApi({
        'prefs:get-onboarding-complete': true,
        'prefs:get-analytics-consent': false,
        'prefs:get-ui-language': 'ko',
        'calendar:get-accounts': [],
        'calendar:get-events': [],
        'updater:get-status': createUpdateStatus({
          state: 'downloaded',
          version: '1.3.1',
          installBlockedReason: reason
        })
      })
      render(
        <I18nProvider>
          <App />
        </I18nProvider>
      )
      expect(await screen.findByText(translate('ko', key))).toBeVisible()
      expect(
        screen.getByRole('button', { name: translate('ko', 'ui.restart'), exact: true })
      ).toBeDisabled()
      act(() => api.emit('prefs:ui-language-changed', 'ja'))
      expect(await screen.findByText(translate('ja', key))).toBeVisible()
      expect(
        screen.getByRole('button', { name: translate('ja', 'ui.restart'), exact: true })
      ).toBeDisabled()
    }
  )

  it('shows the up to date banner in the app banner stack after a manual update check finds no updates', async () => {
    window.location.hash = '#/settings'
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus(),
      'updater:check': undefined,
      'app:get-version': '0.1.11',
      'app:get-runtime-info': undefined,
      'app:get-storage-info': undefined,
      'prefs:get-diagnostic-log-upload-consent': false
    })

    render(<App />)

    const settingsHeading = await screen.findByRole('heading', { name: 'Settings' })
    await userEvent.click(screen.getByRole('button', { name: /check for updates/i }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('updater:check')
    })

    expect(screen.queryByText("You're up to date")).not.toBeInTheDocument()

    act(() => {
      api.emit('updater:status', createUpdateStatus({ state: 'checking' }))
    })
    act(() => {
      api.emit('updater:status', createUpdateStatus({ state: 'idle' }))
    })

    const bannerTitle = await screen.findByText("You're up to date")
    expect(screen.getByText('AutoDoc is running the latest available version.')).toBeInTheDocument()
    expect(
      Boolean(
        bannerTitle.compareDocumentPosition(settingsHeading) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: /dismiss up to date message/i }))

    await waitFor(() => {
      expect(screen.queryByText("You're up to date")).not.toBeInTheDocument()
    })
  })

  it('auto dismisses the up to date banner from the app banner stack', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus()
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()

    vi.useFakeTimers()
    act(() => {
      window.dispatchEvent(new Event('autodoc:manual-update-check'))
      api.emit('updater:status', createUpdateStatus({ state: 'checking' }))
    })
    act(() => {
      api.emit('updater:status', createUpdateStatus({ state: 'idle' }))
    })

    expect(screen.getByText("You're up to date")).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(6_000)
    })

    expect(screen.queryByText("You're up to date")).not.toBeInTheDocument()
  })

  it('opens Settings when the update notification is clicked', async () => {
    const api = installMockElectronApi({
      'prefs:get-onboarding-complete': true,
      'prefs:get-analytics-consent': false,
      'calendar:get-accounts': [],
      'calendar:get-events': [],
      'updater:get-status': createUpdateStatus(),
      'app:get-version': '0.1.11',
      'app:get-runtime-info': undefined,
      'app:get-storage-info': undefined,
      'prefs:get-diagnostic-log-upload-consent': false
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Upcoming' })).toBeInTheDocument()

    act(() => {
      api.emit('updater:open-settings', undefined)
    })

    await waitFor(() => {
      expect(window.location.hash).toBe('#/settings')
    })
  })
})
