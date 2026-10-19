import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { DetectionService } from '../detection'

interface DetectionServicePrivateAccess {
  getWindowSourcesForDetection(): Promise<Array<{ id: string; name: string }>>
}

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

function makeEvent(id: string, startOffsetMs: number): CalendarEvent {
  const startTime = Date.now() + startOffsetMs
  return {
    id,
    externalId: id,
    accountId: 'acct-1',
    provider: 'google',
    recurringEventId: null,
    title: `Event ${id}`,
    startTime,
    endTime: startTime + 30 * 60_000,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: Date.now()
  }
}

describe('DetectionService', () => {
  const originalPlatform = process.platform

  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T14:00:00Z'))
    setPlatform(originalPlatform)
    mocks.showNotificationWindow.mockReset()
    mocks.hideNotificationWindow.mockReset()
    mocks.getAllWindows.mockReset()
    mocks.getAllWindows.mockReturnValue([])
    mocks.getSources.mockReset()
    mocks.getSources.mockResolvedValue([])
    mocks.logAutodocEvent.mockReset()
    mocks.logAutodocFailure.mockReset()
    mocks.isAutoRecordEnabled.mockReset()
    mocks.isAutoRecordEnabled.mockReturnValue(false)
    mocks.getActiveCaptureProcessIdsMac.mockReset()
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.getActiveCaptureProcessIdsWindows.mockReset()
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.focusMainWindow.mockReset()
    mocks.focusMainWindow.mockReturnValue(true)
    mocks.getMainWindow.mockReturnValue({ isFocused: () => false })
    mocks.execFile.mockReset()
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
  })

  it('enumerates detection windows without capturing thumbnails', async () => {
    const sources = [{ id: 'window:1', name: 'Slack' }]
    mocks.getSources.mockResolvedValue(sources as never)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => []
    )

    await expect(
      (service as unknown as DetectionServicePrivateAccess).getWindowSourcesForDetection()
    ).resolves.toEqual(sources)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
  })

  it('does not prompt for a scheduled event before meeting activity is detected', async () => {
    setPlatform('win32')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('evt-1', 5 * 60_000)]
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  it('does not prompt before a scheduled event starts even if provider activity is already detected', async () => {
    setPlatform('win32')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('evt-1', 5 * 60_000)]
    )

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  it('prompts once per scheduled event when the event is in progress and provider activity starts', async () => {
    setPlatform('win32')

    let events = [makeEvent('evt-1', -1 * 60_000)]
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => events
    )

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    await (service as any).poll()

    events = [makeEvent('evt-2', -1 * 60_000)]
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(2)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
    expect(mocks.showNotificationWindow.mock.calls[1][0].title).toBe('Event evt-2')
  })

  it('prompts once per ad-hoc provider activation and resets when provider disappears', async () => {
    setPlatform('win32')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => []
    )

    mocks.getActiveCaptureProcessIdsWindows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['teams.exe'])
      .mockResolvedValueOnce(['teams.exe'])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['zoom.exe'])

    await (service as any).poll()
    await (service as any).poll()
    await (service as any).poll()
    await (service as any).poll()
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(2)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Microsoft Teams')
    expect(mocks.showNotificationWindow.mock.calls[1][0].title).toBe('Zoom')
  })

  it('prefers a timed auto-record event over an earlier all-day event', async () => {
    setPlatform('win32')

    const now = Date.now()
    const allDay: CalendarEvent = {
      ...makeEvent('all-day', -12 * 60 * 60_000),
      title: 'Out of Office',
      startTime: now - 12 * 60 * 60_000,
      endTime: now + 12 * 60 * 60_000,
      isAllDay: true,
      autoRecord: 'off'
    }
    const timed = {
      ...makeEvent('standup', -1 * 60_000),
      title: 'Standup',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      autoRecord: 'once' as const
    }
    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.isAutoRecordEnabled.mockImplementation((eventId: string) => eventId === timed.id)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [allDay, timed]
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-record',
      expect.objectContaining({
        hasCalendarEvent: true,
        providerId: 'google_meet',
        eventId: 'standup'
      })
    )
  })

  it('prefers the later-starting timed meeting over a long working-hours block', async () => {
    setPlatform('win32')

    const now = Date.now()
    const workingHours: CalendarEvent = {
      ...makeEvent('hours', -3 * 60 * 60_000),
      title: 'Working hours',
      startTime: now - 3 * 60 * 60_000,
      endTime: now + 5 * 60 * 60_000,
      autoRecord: 'off'
    }
    const standup = {
      ...makeEvent('standup', -10 * 60_000),
      title: 'Standup',
      meetingUrl: 'https://meet.google.com/abc-defg-hij'
    }
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [workingHours, standup]
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Standup' })
    )
  })

  it('auto-records scheduled events without showing a prompt when enabled', async () => {
    setPlatform('win32')

    const event = makeEvent('evt-1', -1 * 60_000)
    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event]
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-record', {
      hasCalendarEvent: true,
      providerId: 'teams',
      requestId: 1,
      eventId: 'evt-1',
      recurringEventId: null
    })
  })

  it('keeps an actionable source-selection banner visible past the start grace period', async () => {
    setPlatform('win32')
    const send = vi.fn()
    const timed = makeEvent('timed', -60_000)
    const allDay = {
      ...makeEvent('home', -12 * 60 * 60_000),
      isAllDay: true,
      endTime: Date.now() + 12 * 60 * 60_000
    }
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    mocks.isAutoRecordEnabled.mockImplementation((id?: string) => id === 'timed')
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [allDay, timed]
    )
    await service.debugPollNow()
    const payload = send.mock.calls.find(([channel]) => channel === 'detection:auto-record')![1]
    expect(payload).toMatchObject({ eventId: 'timed', providerId: 'slack' })
    service.showSourceSelectionPrompt(payload.requestId)
    const banner = mocks.showNotificationWindow.mock.calls[0][0]
    expect(banner).toMatchObject({
      title: 'Event timed',
      primaryActionLabel: 'Select window',
      autoDismissMs: 0
    })
    mocks.hideNotificationWindow.mockClear()
    await service.debugPollNow(20_000)
    expect(mocks.hideNotificationWindow).not.toHaveBeenCalled()
    expect(mocks.focusMainWindow).not.toHaveBeenCalled()
    banner.onPrimaryAction()
    expect(mocks.focusMainWindow).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('detection:select-window', payload)
  })

  it('cancels an outstanding selection banner when the provider disappears', async () => {
    setPlatform('win32')
    const send = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('timed', -60_000)]
    )
    await service.debugPollNow()
    service.showSourceSelectionPrompt(999)
    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    service.showSourceSelectionPrompt(1)
    const banner = mocks.showNotificationWindow.mock.calls[0][0]
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    await service.debugPollNow()
    expect(mocks.hideNotificationWindow).toHaveBeenCalledWith('meeting-detection')
    banner.onPrimaryAction()
    expect(mocks.focusMainWindow).not.toHaveBeenCalled()
  })

  it('opens the picker directly when AutoDoc already has focus', async () => {
    setPlatform('win32')
    const send = vi.fn()
    mocks.getMainWindow.mockReturnValue({ isFocused: () => true })
    mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('timed', -60_000)]
    )
    await service.debugPollNow()
    service.showSourceSelectionPrompt(1)
    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'detection:select-window',
      expect.objectContaining({ eventId: 'timed' })
    )
  })

  it('suppresses follow-up prompts while an auto-record start is pending', async () => {
    setPlatform('darwin')

    const scheduledEvent = makeEvent('evt-1', -1 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [scheduledEvent]
    )

    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.tinyspeck.slackmacgap'])

    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)

    const promptConfig = mocks.showNotificationWindow.mock.calls[0][0]
    promptConfig.onPrimaryAction()

    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
  })

  it('suppresses activation while a meeting prompt is visible and focuses only on its primary action', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['us.zoom.xos'])
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => []
    )

    await (service as any).poll()

    const promptConfig = mocks.showNotificationWindow.mock.calls[0][0]
    expect(promptConfig).toMatchObject({
      kind: 'meeting-detection',
      suppressAppActivationWhileVisible: true
    })
    expect(mocks.focusMainWindow).not.toHaveBeenCalled()

    promptConfig.onPrimaryAction()

    expect(mocks.focusMainWindow).toHaveBeenCalledOnce()
    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-record', {
      providerId: 'zoom',
      hasCalendarEvent: false,
      requestId: 1,
      eventId: null,
      recurringEventId: null
    })
  })

  it('waits for the event to start before prompting for a matched scheduled event', async () => {
    setPlatform('win32')

    let event = makeEvent('evt-1', 5 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event]
    )

    mocks.getActiveCaptureProcessIdsWindows
      .mockResolvedValueOnce(['slack.exe'])
      .mockResolvedValueOnce(['slack.exe'])

    await (service as any).poll()
    event = makeEvent('evt-1', -1 * 60_000)
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
  })

  it('does not prompt on mac for unknown active input processes', async () => {
    setPlatform('darwin')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => []
    )

    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.apple.corespeechd'])

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  it('uses the matched event title on mac once the event is in progress', async () => {
    setPlatform('darwin')

    let event = makeEvent('evt-1', 5 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event]
    )

    mocks.getActiveCaptureProcessIdsMac
      .mockResolvedValueOnce(['com.tinyspeck.slackmacgap'])
      .mockResolvedValueOnce(['com.tinyspeck.slackmacgap'])

    await (service as any).poll()
    event = makeEvent('evt-1', -1 * 60_000)
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
  })

  it('does not auto-stop on Windows just because provider detection drops while the meeting window remains visible', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:1', name: 'Microsoft Teams' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('does not auto-stop general recordings when meeting signals disappear', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'screen:0:0',
          sourceName: 'Entire screen',
          recordingIntent: 'general'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
    expect(mocks.logAutodocEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Auto-stop confirmed after sustained missing meeting signals'
      })
    )
  })

  it('still auto-stops on Windows when the meeting window actually disappears', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'window_closed',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('does not auto-stop on Windows when the recorded meeting window disappears but the provider is still active', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Slack Huddle',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('auto-stops on Windows screen capture when the tracked meeting window disappears after the provider goes away', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(async () => [{ id: 'window:other', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'screen:0:0',
          sourceName: 'Entire screen',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'screen',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('auto-stops on Windows when provider is gone and recorded window closes, even if the meeting app window stays open', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(async () => [{ id: 'window:other', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: true
      })
    )
  })

  it('auto-stops on Windows when a tracked Slack huddle window downgrades to a generic Slack window after the provider disappears', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(async () => [{ id: 'window:1', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Slack | Huddle',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('does not auto-stop on Windows when a tracked Slack huddle window downgrades to a generic Slack window but the provider is still active', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    mocks.getSources.mockImplementation(async () => [{ id: 'window:1', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Slack | Huddle',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('auto-stops on Windows when a tracked Teams meeting window changes to a different Teams page after the provider disappears', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:1', name: 'Chat | Microsoft Teams' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Roadmap Sync | Microsoft Teams',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Roadmap Sync | Microsoft Teams',
          trackedMeetingProviderId: 'teams'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('does not auto-stop on Windows when a tracked Teams meeting window changes title but the provider is still active', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:1', name: 'Chat | Microsoft Teams' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Roadmap Sync | Microsoft Teams',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Roadmap Sync | Microsoft Teams',
          trackedMeetingProviderId: 'teams'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('does not auto-stop on Windows screen capture when the tracked meeting window disappears but the provider is still active', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
    mocks.getSources.mockImplementation(async () => [{ id: 'window:other', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'screen:0:0',
          sourceName: 'Entire screen',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('auto-stops on macOS when provider is gone and recorded window closes while mic is idle, even if the meeting app window stays open', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
    mocks.getSources.mockImplementation(async () => [{ id: 'window:other', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: true
      })
    )
  })

  it('auto-stops on macOS screen capture when the tracked meeting window disappears after the provider goes away, even if audio-in still looks active', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockImplementation(async () => [{ id: 'window:other', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'screen:0:0',
          sourceName: 'Entire screen',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'screen',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('does not auto-stop on macOS just because app focus or space changes hide the captured window', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.tinyspeck.slackmacgap'])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:other', name: 'Slack | Huddle' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('does not auto-stop on macOS when the tracked Slack huddle window still looks active but provider and mic signals disappear', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
    mocks.getSources.mockImplementation(
      async () =>
        [{ id: 'window:1', name: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          meetingId: 'meeting-guarded',
          sourceId: 'window:1',
          sourceName: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 12; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'detection',
        meetingId: 'meeting-guarded',
        message:
          'Auto-stop blocked — tracked meeting window still looks active on macOS despite idle mic/provider signals'
      })
    )
  })

  it('still auto-stops on macOS when a tracked Slack huddle window downgrades back to generic Slack after the provider disappears', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
    mocks.getSources.mockImplementation(async () => [{ id: 'window:1', name: 'Slack' }] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'provider_gone',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('currently auto-stops on macOS when the captured meeting window disappears even if provider activity and mic activity continue', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.tinyspeck.slackmacgap'])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          sourceId: 'window:1',
          sourceName: 'Slack Huddle',
          trackedMeetingSourceId: 'window:1',
          trackedMeetingSourceName: 'Slack | Huddle',
          trackedMeetingProviderId: 'slack'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 5; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'window_closed',
        sourceType: 'window',
        providerDetected: true,
        meetingWindowVisible: false
      })
    )
  })

  it('still auto-stops on macOS when provider is gone and no meeting window remains', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      {
        getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' })
      } as never,
      () => []
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith(
      'detection:auto-stop',
      expect.objectContaining({
        reason: 'window_closed',
        sourceType: 'window',
        providerDetected: false,
        meetingWindowVisible: false
      })
    )
  })

  it('logs when auto-stop is suppressed because the meeting still appears visible after a window switch', async () => {
    setPlatform('darwin')

    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.tinyspeck.slackmacgap'])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:other', name: 'Slack | Huddle' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          meetingId: 'meeting-1',
          sourceId: 'window:1',
          sourceName: 'Slack Huddle'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 3; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'detection',
        meetingId: 'meeting-1',
        message:
          'Auto-stop suppressed — possible focus or desktop switch while meeting remains visible'
      })
    )
  })

  it('logs when auto-stop is blocked because the meeting window lingers after provider activity disappears', async () => {
    setPlatform('win32')

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(
      async () => [{ id: 'window:1', name: 'Slack | Huddle' }] as any
    )

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording: true,
          meetingId: 'meeting-2',
          sourceId: 'window:1',
          sourceName: 'Slack Huddle'
        })
      } as never,
      () => []
    )

    for (let i = 0; i < 4; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'detection',
        meetingId: 'meeting-2',
        message:
          'Auto-stop blocked — meeting provider disappeared, but the meeting window is still visible'
      })
    )
  })

  it('does not immediately re-prompt after a manual stop while the same meeting signal is still active', async () => {
    setPlatform('win32')

    let isRecording = true
    const event = makeEvent('evt-1', -1 * 60_000)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])

    const service = new DetectionService(
      {
        getState: () => ({
          isRecording,
          sourceId: 'window:1',
          sourceName: 'Slack - Huddle'
        })
      } as never,
      () => [event]
    )

    await (service as any).poll()
    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()

    isRecording = false
    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  describe('auto-record started notice', () => {
    const startSilentAutoRecord = async (
      options: { isRecording?: () => boolean; stopRecording?: () => Promise<void> } = {}
    ): Promise<{ service: DetectionService; requestId: number }> => {
      setPlatform('win32')
      const send = vi.fn()
      mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
      mocks.isAutoRecordEnabled.mockReturnValue(true)
      mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
      const service = new DetectionService(
        { getState: () => ({ isRecording: options.isRecording?.() ?? true }) } as never,
        () => [makeEvent('evt-1', -60_000)],
        options.stopRecording
      )
      ;(service as any).requestAutoRecord('Event evt-1', 'slack', null, false)
      const payload = send.mock.calls.find(([channel]) => channel === 'detection:auto-record')![1]
      return { service, requestId: payload.requestId }
    }

    it('shows a stoppable notice after a silent auto-start', async () => {
      const { service, requestId } = await startSilentAutoRecord()
      service.showAutoRecordStartedNotice(requestId)

      expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
      expect(mocks.showNotificationWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'AI Notes Started',
          body: 'Event evt-1 is being recorded.',
          bodyTitle: 'Event evt-1',
          bodySuffix: 'is being recorded.',
          primaryActionLabel: 'Stop',
          kind: 'recording-started',
          autoDismissMs: 15_000,
          suppressAppActivationWhileVisible: true
        })
      )
      expect(mocks.logAutodocEvent).toHaveBeenCalledWith({
        area: 'detection',
        message: 'Auto-record started notice shown',
        context: { requestId }
      })
    })

    it('does not show the notice for a stale request id or when not recording', async () => {
      const stale = await startSilentAutoRecord()
      stale.service.showAutoRecordStartedNotice(stale.requestId + 1)
      expect(mocks.showNotificationWindow).not.toHaveBeenCalled()

      const idle = await startSilentAutoRecord({ isRecording: () => false })
      idle.service.showAutoRecordStartedNotice(idle.requestId)
      expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    })

    it('does not show the notice when the user confirmed with Start AI Notes', async () => {
      setPlatform('win32')
      const send = vi.fn()
      mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
      mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['slack.exe'])
      const service = new DetectionService(
        { getState: () => ({ isRecording: true }) } as never,
        () => [makeEvent('evt-1', -60_000)]
      )
      ;(service as any).showPrompt('Event evt-1', 'slack', null)
      mocks.showNotificationWindow.mock.calls[0][0].onPrimaryAction()
      const payload = send.mock.calls.find(([channel]) => channel === 'detection:auto-record')![1]
      mocks.showNotificationWindow.mockClear()

      service.showAutoRecordStartedNotice(payload.requestId)

      expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    })

    it('still shows the notice when a poll clears the pending request first', async () => {
      const { service, requestId } = await startSilentAutoRecord()
      await (service as any).poll()
      service.showAutoRecordStartedNotice(requestId)
      expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    })

    it('stops through the normal stop path without re-triggering the same call', async () => {
      let isRecording = true
      const stopRecording = vi.fn(async () => {
        isRecording = false
      })
      const send = vi.fn()
      const { service, requestId } = await startSilentAutoRecord({
        isRecording: () => isRecording,
        stopRecording
      })
      mocks.getAllWindows.mockReturnValue([{ webContents: { send } }] as never)
      service.showAutoRecordStartedNotice(requestId)
      mocks.showNotificationWindow.mock.calls[0][0].onPrimaryAction()
      await Promise.resolve()

      expect(stopRecording).toHaveBeenCalledTimes(1)
      expect(mocks.logAutodocEvent).toHaveBeenCalledWith({
        area: 'detection',
        message: 'Auto-record stopped from notice',
        context: { requestId }
      })

      await (service as any).poll()
      await (service as any).poll()
      expect(send).not.toHaveBeenCalledWith('detection:auto-record', expect.anything())
      expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    })

    it('hides the notice when the recording stops for another reason', async () => {
      let isRecording = true
      const { service, requestId } = await startSilentAutoRecord({
        isRecording: () => isRecording
      })
      service.showAutoRecordStartedNotice(requestId)
      isRecording = false
      await (service as any).poll()

      expect(mocks.hideNotificationWindow).toHaveBeenCalledWith('recording-started')
    })
  })
})
