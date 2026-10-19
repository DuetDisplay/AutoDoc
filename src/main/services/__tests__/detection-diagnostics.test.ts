import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { DetectionService } from '../detection'

const mocks = vi.hoisted(() => ({
  showNotificationWindow: vi.fn(),
  hideNotificationWindow: vi.fn(),
  getAllWindows: vi.fn(() => []),
  getSources: vi.fn(async () => []),
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn(),
  isAutoRecordEnabled: vi.fn((_eventId: string, _recurringEventId?: string) => false),
  getActiveCaptureProcessIdsMac: vi.fn(async () => [] as string[]),
  getActiveCaptureProcessIdsWindows: vi.fn(async () => [] as string[]),
  focusMainWindow: vi.fn(() => true),
  getMainWindow: vi.fn((): { isFocused: () => boolean } => ({ isFocused: () => false })),
  execFile: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  desktopCapturer: { getSources: mocks.getSources }
}))

vi.mock('../../notification-window', () => ({
  showNotificationWindow: mocks.showNotificationWindow,
  hideNotificationWindow: mocks.hideNotificationWindow
}))

vi.mock('../auto-record-store', () => ({
  isAutoRecordEnabled: mocks.isAutoRecordEnabled
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent,
  logAutodocFailure: mocks.logAutodocFailure
}))

vi.mock('../mac-meeting-detector', () => ({
  getActiveCaptureProcessIdsMac: mocks.getActiveCaptureProcessIdsMac
}))

vi.mock('../windows-meeting-detector', () => ({
  getActiveCaptureProcessIdsWindows: mocks.getActiveCaptureProcessIdsWindows
}))

vi.mock('../main-window', () => ({
  focusMainWindow: mocks.focusMainWindow,
  getMainWindow: mocks.getMainWindow
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile
}))

function makeEvent(
  id: string,
  startOffsetMs: number,
  overrides: Partial<CalendarEvent> = {}
): CalendarEvent {
  const startTime = Date.now() + startOffsetMs
  return {
    id,
    externalId: id,
    accountId: 'acct-1',
    provider: 'google',
    recurringEventId: null,
    title: 'Testing Autodoc',
    startTime,
    endTime: startTime + 30 * 60_000,
    attendees: [{ name: 'Jamal', email: 'jamal@example.com' }] as never,
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: Date.now(),
    ...overrides
  }
}

function logged(message: string): Array<Record<string, unknown>> {
  return mocks.logAutodocEvent.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.message === message)
    .map((entry) => entry.context ?? {})
}

function decisions(): Array<Record<string, unknown>> {
  return logged('Meeting detection decision')
}

describe('DetectionService diagnostics', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T14:00:00Z'))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    for (const mock of Object.values(mocks)) {
      if ('mockReset' in mock) mock.mockReset()
    }
    mocks.getAllWindows.mockReturnValue([])
    mocks.getSources.mockResolvedValue([])
    mocks.isAutoRecordEnabled.mockReturnValue(false)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.focusMainWindow.mockReturnValue(true)
    mocks.getMainWindow.mockReturnValue({ isFocused: () => false })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.useRealTimers()
  })

  const notRecording = { getState: () => ({ isRecording: false }) } as never

  it('logs provider signal changes once, not on every poll', async () => {
    const service = new DetectionService(notRecording, () => [])
    await service.debugPollNow()
    await service.debugPollNow()
    expect(logged('No meeting provider signal')).toHaveLength(1)

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    await service.debugPollNow()
    await service.debugPollNow()
    await service.debugPollNow()
    expect(logged('Meeting provider signal appeared')).toEqual([
      {
        providerId: 'slack',
        previousProviderId: null,
        detector: 'windows_helper',
        activeProcessNames: ['slack.exe']
      }
    ])

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    await service.debugPollNow()
    await service.debugPollNow()
    expect(logged('Meeting provider signal disappeared')).toHaveLength(1)
  })

  it('logs calendar candidates with all-day and auto-record flags and the chosen id', async () => {
    mocks.isAutoRecordEnabled.mockImplementation((id: string) => id === 'timed')
    const allDay = makeEvent('home', -12 * 3_600_000, {
      isAllDay: true,
      endTime: Date.now() + 12 * 3_600_000,
      title: 'Home'
    })
    const timed = makeEvent('timed', -60_000, { meetingUrl: 'https://meet.google.com/abc-defg' })
    const service = new DetectionService(notRecording, () => [allDay, timed])
    await service.debugPollNow()
    await service.debugPollNow()

    const entries = logged('Calendar candidates changed')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      calendarEventCount: 2,
      candidateCount: 2,
      chosenEventId: 'timed',
      chosenRule: 'only_timed_candidate'
    })
    expect(entries[0].candidates).toEqual([
      expect.objectContaining({
        eventId: 'home',
        isAllDay: true,
        autoRecordEnabled: false,
        hasMeetingUrl: false,
        meetingUrlProvider: null
      }),
      expect.objectContaining({
        eventId: 'timed',
        isAllDay: false,
        autoRecordEnabled: true,
        hasMeetingUrl: true,
        meetingUrlProvider: 'google_meet',
        startTime: timed.startTime,
        endTime: timed.endTime
      })
    ])
  })

  it('names the rule when auto-record preference or start time picks between timed events', async () => {
    mocks.isAutoRecordEnabled.mockImplementation((id: string) => id === 'early')
    const early = makeEvent('early', -20 * 60_000)
    const late = makeEvent('late', -60_000)
    const service = new DetectionService(notRecording, () => [early, late])
    await service.debugPollNow()
    expect(logged('Calendar candidates changed')[0]).toMatchObject({
      chosenEventId: 'early',
      chosenRule: 'auto_record_enabled_preferred'
    })
  })

  it('logs each decision reason once on change, with the real branch name', async () => {
    const send = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    const service = new DetectionService(notRecording, () => [makeEvent('timed', -60_000)])

    await service.debugPollNow()
    await service.debugPollNow()
    expect(decisions()).toEqual([
      { decision: 'skip', reason: 'no_provider_signal', eventId: 'timed' }
    ])

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    await service.debugPollNow()
    await service.debugPollNow()
    await service.debugPollNow()
    expect(decisions().slice(1)).toEqual([
      {
        decision: 'prompt',
        reason: 'calendar_event_without_auto_record',
        eventId: 'timed',
        providerId: 'slack'
      },
      {
        decision: 'skip',
        reason: 'already_prompted_for_event',
        eventId: 'timed',
        providerId: 'slack'
      }
    ])
    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
  })

  it('logs why nothing happens: upcoming event, suppression and pending auto-record', async () => {
    const upcoming = makeEvent('soon', 5 * 60_000)
    const service = new DetectionService(notRecording, () => [upcoming])
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['zoom.exe'])
    await service.debugPollNow()
    await service.debugPollNow()
    expect(decisions()).toEqual([
      {
        decision: 'skip',
        reason: 'upcoming_event_within_10_min',
        upcomingEventId: 'soon',
        providerId: 'zoom'
      }
    ])
    expect(mocks.hideNotificationWindow).toHaveBeenCalledWith(
      'meeting-detection',
      'upcoming_event_within_10_min'
    )

    mocks.isAutoRecordEnabled.mockReturnValue(true)
    const pending = new DetectionService(notRecording, () => [makeEvent('timed', -60_000)])
    await pending.debugPollNow()
    await pending.debugPollNow()
    expect(decisions().map((entry) => entry.reason)).toEqual([
      'upcoming_event_within_10_min',
      'auto_record_enabled_for_event',
      'auto_record_pending'
    ])
  })

  it('logs recording_in_progress and suppression after a recording ends', async () => {
    let isRecording = true
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    const service = new DetectionService(
      { getState: () => ({ isRecording, recordingIntent: 'general' }) } as never,
      () => [makeEvent('timed', -60_000)]
    )
    await service.debugPollNow()
    await service.debugPollNow()
    expect(decisions()).toEqual([{ decision: 'skip', reason: 'recording_in_progress' }])

    isRecording = false
    await service.debugPollNow()
    await service.debugPollNow()
    expect(decisions().slice(1)).toEqual([
      {
        decision: 'skip',
        reason: 'suppressed_after_manual_stop',
        eventId: 'timed',
        providerId: 'slack'
      }
    ])
  })

  it('logs the start prompt banner lifecycle with the right reasons', async () => {
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    const service = new DetectionService(notRecording, () => [makeEvent('timed', -60_000)])
    await service.debugPollNow()
    const banner = mocks.showNotificationWindow.mock.calls[0][0]
    expect(logged('Notification banner shown')).toEqual([
      {
        bannerKind: 'start_prompt',
        notificationKind: 'meeting-detection',
        requestId: null,
        nextRequestId: 1,
        eventId: 'timed',
        providerId: 'slack',
        hasCalendarEvent: true
      }
    ])

    banner.onDismiss('user')
    banner.onDismiss('timeout')
    banner.onHidden('call_ended')
    banner.onPrimaryAction()
    expect(logged('Notification banner dismissed by user')).toHaveLength(1)
    expect(logged('Notification banner auto-dismissed by timeout')).toHaveLength(1)
    expect(logged('Notification banner hidden by app')).toEqual([
      expect.objectContaining({ bannerKind: 'start_prompt', reason: 'call_ended' })
    ])
    expect(logged('Notification banner primary action clicked')).toHaveLength(1)
    expect(logged('Auto-record requested')).toEqual([
      expect.objectContaining({ requestId: 1, eventId: 'timed', confirmedByUser: true })
    ])
  })

  it('logs the select-window banner and the started notice lifecycle', async () => {
    const send = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    let isRecording = false
    const service = new DetectionService({ getState: () => ({ isRecording }) } as never, () => [
      makeEvent('timed', -60_000)
    ])
    await service.debugPollNow()
    service.showSourceSelectionPrompt(1)
    const selectBanner = mocks.showNotificationWindow.mock.calls[0][0]
    expect(logged('Notification banner shown')[0]).toEqual({
      bannerKind: 'select_window',
      notificationKind: 'meeting-detection',
      requestId: 1,
      eventId: 'timed',
      providerId: 'slack'
    })
    selectBanner.onPrimaryAction()
    expect(logged('Notification banner primary action clicked')[0]).toMatchObject({
      bannerKind: 'select_window',
      requestId: 1
    })

    isRecording = true
    service.showAutoRecordStartedNotice(1)
    expect(logged('Notification banner shown')[1]).toMatchObject({
      bannerKind: 'recording_started',
      notificationKind: 'recording-started',
      requestId: 1,
      eventId: 'timed'
    })
    mocks.showNotificationWindow.mock.calls[1][0].onDismiss('timeout')
    expect(logged('Notification banner auto-dismissed by timeout')).toEqual([
      expect.objectContaining({ bannerKind: 'recording_started' })
    ])
    service.stop()
    expect(mocks.hideNotificationWindow).toHaveBeenCalledWith(
      'meeting-detection',
      'service_stopped'
    )
  })

  it('never logs event titles, attendees or meeting URLs', async () => {
    const send = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    let isRecording = false
    const timed = makeEvent('timed', -60_000, { meetingUrl: 'https://meet.google.com/secret-room' })
    const service = new DetectionService({ getState: () => ({ isRecording }) } as never, () => [
      makeEvent('home', -3_600_000, {
        isAllDay: true,
        title: 'Jamal Home',
        endTime: Date.now() + 3_600_000
      }),
      timed
    ])
    await service.debugPollNow()
    service.showSourceSelectionPrompt(1)
    mocks.showNotificationWindow.mock.calls[0][0].onPrimaryAction()
    isRecording = true
    service.showAutoRecordStartedNotice(1)
    mocks.showNotificationWindow.mock.calls[1][0].onDismiss('user')
    service.stop()

    const everything = JSON.stringify(mocks.logAutodocEvent.mock.calls)
    expect(everything).not.toContain('Testing Autodoc')
    expect(everything).not.toContain('Jamal')
    expect(everything).not.toContain('jamal@example.com')
    expect(everything).not.toContain('secret-room')
  })
})
