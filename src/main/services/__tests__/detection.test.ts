import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { DetectionService } from '../detection'

const mocks = vi.hoisted(() => ({
  showNotificationWindow: vi.fn(),
  hideNotificationWindow: vi.fn(),
  getAllWindows: vi.fn(() => []),
  isAutoRecordEnabled: vi.fn(() => false),
  getActiveCaptureProcessIdsWindows: vi.fn(async () => [] as string[]),
  execFile: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}))

vi.mock('../../notification-window', () => ({
  showNotificationWindow: mocks.showNotificationWindow,
  hideNotificationWindow: mocks.hideNotificationWindow,
}))

vi.mock('../auto-record-store', () => ({
  isAutoRecordEnabled: mocks.isAutoRecordEnabled,
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
    mocks.isAutoRecordEnabled.mockReset()
    mocks.isAutoRecordEnabled.mockReturnValue(false)
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

  it('prompts once per scheduled event when provider activity starts', async () => {
    setPlatform('win32')

    let events = [makeEvent('evt-1', 5 * 60_000)]
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => events,
    )

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    await (service as any).poll()

    events = [makeEvent('evt-2', 5 * 60_000)]
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

    const event = makeEvent('evt-1', 5 * 60_000)
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
    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-record', {})
  })

  it('waits for provider activity before prompting for a matched scheduled event', async () => {
    setPlatform('win32')

    const event = makeEvent('evt-1', 5 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event],
    )

    mocks.getActiveCaptureProcessIdsWindows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['slack.exe'])

    await (service as any).poll()
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
  })

  it('uses the matched event title on mac once mic activity starts', async () => {
    setPlatform('darwin')

    const event = makeEvent('evt-1', 5 * 60_000)
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event],
    )

    mocks.execFile
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, '', '')
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, 'audio-in', '')
      })

    await (service as any).poll()
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(1)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
  })

  it('auto-stops on Windows after the meeting provider disappears during recording', async () => {
    setPlatform('win32')

    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])

    const service = new DetectionService(
      { getState: () => ({ isRecording: true, sourceId: null }) } as never,
      () => [],
    )

    await (service as any).poll()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-stop', { reason: 'provider_gone' })
  })
})
