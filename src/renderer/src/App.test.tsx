import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import {
  createCalendarAccount,
  createCalendarEvent,
  createRecordingEntry,
  installMockElectronApi,
  resetRendererStores
} from './test/fixtures'

vi.mock('./hooks/useRecording', () => ({
  useRecording: () => ({
    isRecording: false,
    sourceName: null,
    elapsedSeconds: 0,
    handleStop: vi.fn(),
    fetchSources: vi.fn(),
    handleStart: vi.fn()
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

describe('App', () => {
  beforeEach(() => {
    resetRendererStores()
    window.location.hash = '#/'
  })

  afterEach(() => {
    window.location.hash = '#/'
  })

  it('shows onboarding when the first-run flow is not complete yet', async () => {
    installMockElectronApi({
      'prefs:get-onboarding-complete': false,
      'prefs:get-analytics-consent': null,
      'calendar:get-accounts': [],
      'calendar:get-events': []
    })

    render(<App />)

    expect(await screen.findByText(/your meetings talk/i)).toBeInTheDocument()
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
    api.emit('calendar:connection-changed', false)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /connect google calendar/i })).toBeInTheDocument()
    })
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
})
