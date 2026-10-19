import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecording, useRecordingActions } from '../useRecording'
import { getSavedSourcePreference } from '../../services/recording-source-preferences'
import { installMockElectronApi, resetRendererStores } from '../../test/fixtures'

vi.mock('../../services/recording-capture', () => ({
  startCapture: vi.fn(async () => {}),
  stopCapture: vi.fn(async () => {}),
  setUnrecoverableCaptureHandler: vi.fn(),
  setVideoDisabledHandler: vi.fn()
}))

vi.mock('../../services/finish-recording', () => ({
  finishRecording: vi.fn(async () => {}),
  trackRecordingStart: vi.fn((promise: Promise<unknown>) => promise)
}))

vi.mock('../../services/analytics', () => ({
  getDaysSinceFirstLaunch: vi.fn(async () => 0),
  toDurationBucket: vi.fn(() => '0-1m'),
  trackEvent: vi.fn(),
  trackFirstEventOnce: vi.fn(async () => {})
}))

vi.mock('../../services/diagnostic-trail', () => ({
  recordDiagnosticAction: vi.fn(),
  recordPersistentDiagnosticAction: vi.fn()
}))

vi.mock('../../services/renderer-sentry', () => ({
  captureRecordingStartFailure: vi.fn()
}))

const selectionContext = { eventId: 'timed', recurringEventId: 'series', providerHint: 'slack' }
const trackingContext = {
  meetingSourceId: 'window:main',
  meetingSourceName: 'Main - Slack',
  providerId: 'slack',
  recordingIntent: 'meeting' as const,
  selectionEventId: 'timed'
}

describe.each([
  ['useRecording', () => useRecording()],
  ['useRecordingActions', () => useRecordingActions()]
])('%s handleStart source preference', (_name, useHook) => {
  beforeEach(() => {
    resetRendererStores()
    window.localStorage.clear()
    installMockElectronApi({
      'recording:get-state': { isRecording: false },
      'recording:start': { meetingId: 'meeting-1' },
      'recording:stop': undefined
    })
  })

  it('does not remember the window after a silent automatic start', async () => {
    const { result } = renderHook(useHook)
    await act(async () => {
      await result.current.handleStart(
        'window:main',
        'Main - Slack',
        selectionContext,
        trackingContext
      )
    })

    expect(getSavedSourcePreference(selectionContext)).toBeNull()
    expect(window.localStorage.getItem('autodoc:recording-source-preferences')).toBeNull()
  })

  it('remembers the window when the user chose it', async () => {
    const { result } = renderHook(useHook)
    await act(async () => {
      await result.current.handleStart(
        'window:huddle',
        'Huddle - Slack',
        selectionContext,
        trackingContext,
        { rememberSource: true }
      )
    })

    expect(getSavedSourcePreference(selectionContext)).toMatchObject({
      sourceId: 'window:huddle',
      sourceName: 'Huddle - Slack'
    })
  })
})
