import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { DetectionService } from '../detection'

const mocks = vi.hoisted(() => ({
  showNotificationWindow: vi.fn(),
  hideNotificationWindow: vi.fn(),
  getAllWindows: vi.fn(() => []),
  getSources: vi.fn(async () => []),
  logAutodocEvent: vi.fn(),
  logAutodocFailure: vi.fn(),
  isAutoRecordEnabled: vi.fn(() => false),
  getActiveCaptureProcessIdsMac: vi.fn(async () => [] as string[]),
  getActiveCaptureProcessIdsWindows: vi.fn(async () => [] as string[]),
  execFile: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  desktopCapturer: { getSources: mocks.getSources },
}))

vi.mock('../../notification-window', () => ({
  showNotificationWindow: mocks.showNotificationWindow,
  hideNotificationWindow: mocks.hideNotificationWindow,
}))

vi.mock('../auto-record-store', () => ({
  isAutoRecordEnabled: mocks.isAutoRecordEnabled,
}))

vi.mock('../autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent,
  logAutodocFailure: mocks.logAutodocFailure,
}))

vi.mock('../mac-meeting-detector', () => ({
  getActiveCaptureProcessIdsMac: mocks.getActiveCaptureProcessIdsMac,
}))

vi.mock('../windows-meeting-detector', () => ({
  getActiveCaptureProcessIdsWindows: mocks.getActiveCaptureProcessIdsWindows,
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
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
    syncedAt: Date.now(),
  }
}

describe('DetectionService', () => {
  const originalPlatform = process.platform

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
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
    mocks.execFile.mockReset()
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
    })
  })

  it('does not prompt for a scheduled event before meeting activity is detected', async () => {
    setPlatform('win32')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('evt-1', 5 * 60_000)],
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  it('does not prompt before a scheduled event starts even if provider activity is already detected', async () => {
    setPlatform('win32')

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [makeEvent('evt-1', 5 * 60_000)],
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
      () => events,
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
      () => [],
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

  it('auto-records scheduled events without showing a prompt when enabled', async () => {
    setPlatform('win32')

    const event = makeEvent('evt-1', -1 * 60_000)
    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.isAutoRecordEnabled.mockReturnValue(true)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event],
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-record', {
      hasCalendarEvent: true,
      providerId: null,
    })
  })

  it('suppresses follow-up prompts while an auto-record start is pending', async () => {
    setPlatform('darwin')

    const scheduledEvent = makeEvent('evt-1', -1 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [scheduledEvent],
    )

    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue(['com.tinyspeck.slackmacgap'])

    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)

    const promptConfig = mocks.showNotificationWindow.mock.calls[0][0]
    promptConfig.onRecord()

    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
  })

  it('waits for the event to start before prompting for a matched scheduled event', async () => {
    setPlatform('win32')

    let event = makeEvent('evt-1', 5 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event],
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
      () => [],
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
      () => [event],
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
    mocks.getSources.mockImplementation(async () => ([
      { id: 'window:1', name: 'Microsoft Teams' },
    ] as any))

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
  })

  it('still auto-stops on Windows when the meeting window actually disappears', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockResolvedValue([] as any)

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-stop', expect.objectContaining({
      reason: 'window_closed',
      sourceType: 'window',
      providerDetected: false,
      meetingWindowVisible: false,
    }))
  })

  it('does not auto-stop on macOS just because app focus or space changes hide the captured window', async () => {
    setPlatform('darwin')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockImplementation(async () => ([
      { id: 'window:other', name: 'Slack | Huddle' },
    ] as any))

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).not.toHaveBeenCalledWith('detection:auto-stop', expect.anything())
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
      { getState: () => ({ isRecording: true, sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 8; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-stop', expect.objectContaining({
      reason: 'window_closed',
      sourceType: 'window',
      providerDetected: false,
      meetingWindowVisible: false,
    }))
  })

  it('logs when auto-stop is suppressed because the meeting still appears visible after a window switch', async () => {
    setPlatform('darwin')

    mocks.getActiveCaptureProcessIdsMac.mockResolvedValue([])
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, 'audio-in', '')
    })
    mocks.getSources.mockImplementation(async () => ([
      { id: 'window:other', name: 'Slack | Huddle' },
    ] as any))

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, meetingId: 'meeting-1', sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 3; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(expect.objectContaining({
      area: 'detection',
      meetingId: 'meeting-1',
      message: 'Auto-stop suppressed — possible focus or desktop switch while meeting remains visible',
    }))
  })

  it('logs when auto-stop is blocked because the meeting window lingers after provider activity disappears', async () => {
    setPlatform('win32')

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
    mocks.getSources.mockImplementation(async () => ([
      { id: 'window:1', name: 'Slack | Huddle' },
    ] as any))

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, meetingId: 'meeting-2', sourceId: 'window:1', sourceName: 'Slack Huddle' }) } as never,
      () => [],
    )

    for (let i = 0; i < 4; i += 1) {
      await (service as any).poll()
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(expect.objectContaining({
      area: 'detection',
      meetingId: 'meeting-2',
      message: 'Auto-stop blocked — meeting provider disappeared, but the meeting window is still visible',
    }))
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
          sourceName: 'Slack - Huddle',
        }),
      } as never,
      () => [event],
    )

    await (service as any).poll()
    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()

    isRecording = false
    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })
})
