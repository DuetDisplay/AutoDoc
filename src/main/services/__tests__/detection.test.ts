import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { DetectionService } from '../detection'

const mocks = vi.hoisted(() => ({
  showNotificationWindow: vi.fn(),
  hideNotificationWindow: vi.fn(),
  getAllWindows: vi.fn(() => []),
  isAutoRecordEnabled: vi.fn(() => false),
  getActiveCaptureProcessIdsWindows: vi.fn(async () => [] as string[]),
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

function makeEvent(id: string, startOffsetMs: number): CalendarEvent {
  const startTime = Date.now() + startOffsetMs
  return {
    id,
    googleEventId: id,
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
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T14:00:00Z'))
    mocks.showNotificationWindow.mockReset()
    mocks.hideNotificationWindow.mockReset()
    mocks.getAllWindows.mockReset()
    mocks.getAllWindows.mockReturnValue([])
    mocks.isAutoRecordEnabled.mockReset()
    mocks.isAutoRecordEnabled.mockReturnValue(false)
    mocks.getActiveCaptureProcessIdsWindows.mockReset()
    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue([])
  })

  it('prompts once per scheduled event even while ad-hoc detection remains active', async () => {
    let events = [makeEvent('evt-1', 5 * 60_000)]
    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => events,
    )

    mocks.getActiveCaptureProcessIdsWindows.mockResolvedValue(['teams.exe'])

    await (service as any).poll()
    await (service as any).poll()

    events = [makeEvent('evt-2', 5 * 60_000)]
    await (service as any).poll()

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(2)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
    expect(mocks.showNotificationWindow.mock.calls[1][0].title).toBe('Event evt-2')
  })

  it('prompts once per ad-hoc provider activation and resets when provider disappears', async () => {
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
    const event = makeEvent('evt-1', 5 * 60_000)
    const webContentsSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([{ webContents: { send: webContentsSend } }] as any)
    mocks.isAutoRecordEnabled.mockReturnValue(true)

    const service = new DetectionService(
      { getState: () => ({ isRecording: false }) } as never,
      () => [event],
    )

    await (service as any).poll()

    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
    expect(webContentsSend).toHaveBeenCalledWith('detection:auto-record', {})
  })

  it('re-prompts when a provider activates during an already-matched scheduled event', async () => {
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

    expect(mocks.showNotificationWindow).toHaveBeenCalledTimes(2)
    expect(mocks.showNotificationWindow.mock.calls[0][0].title).toBe('Event evt-1')
    expect(mocks.showNotificationWindow.mock.calls[1][0].title).toBe('Event evt-1')
  })
})
