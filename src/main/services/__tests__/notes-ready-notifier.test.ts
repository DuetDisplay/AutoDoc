import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readMetadata: vi.fn(),
  encryptJSON: vi.fn(),
  showNotificationWindow: vi.fn(),
  focusMainWindow: vi.fn(),
  getMainWindow: vi.fn()
}))

vi.mock('../calendar-matcher', () => ({
  readMetadata: mocks.readMetadata
}))

vi.mock('../crypto', () => ({
  encryptJSON: mocks.encryptJSON
}))

vi.mock('../../notification-window', () => ({
  showNotificationWindow: mocks.showNotificationWindow
}))

vi.mock('../main-window', () => ({
  focusMainWindow: mocks.focusMainWindow,
  getMainWindow: mocks.getMainWindow
}))

const { buildNotesReadyBody, notifyNotesReady } = await import('../notes-ready-notifier')

describe('notes ready notifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds a fallback body when there is no meeting title', () => {
    expect(buildNotesReadyBody(null)).toBe('Your latest meeting is ready.')
  })

  it('shows the notification once and persists the dedupe marker', async () => {
    const send = vi.fn()
    mocks.getMainWindow.mockReturnValue({ webContents: { send } })
    mocks.readMetadata.mockResolvedValue({
      sourceName: 'Weekly Sync',
      startedAt: 1,
      stoppedAt: 2,
      durationSeconds: 60
    })

    const shown = await notifyNotesReady('/tmp/autodoc-tests', 'meeting-123')

    expect(shown).toBe(true)
    expect(mocks.showNotificationWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Notes Ready',
        primaryActionLabel: 'Open Notes',
        kind: 'notes-ready'
      })
    )
    expect(mocks.encryptJSON).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceName: 'Weekly Sync',
        notesReadyNotificationSentAt: expect.any(Number)
      }),
      '/tmp/autodoc-tests/meeting-123/metadata.json'
    )
    expect(mocks.showNotificationWindow.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.encryptJSON.mock.invocationCallOrder[0]
    )

    const options = mocks.showNotificationWindow.mock.calls[0]?.[0]
    options.onPrimaryAction()

    expect(mocks.focusMainWindow).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('notes:open-meeting', { meetingId: 'meeting-123' })
  })

  it('does not show a duplicate notification when the marker is already set', async () => {
    mocks.readMetadata.mockResolvedValue({
      sourceName: 'Weekly Sync',
      startedAt: 1,
      stoppedAt: 2,
      durationSeconds: 60,
      notesReadyNotificationSentAt: Date.now()
    })

    const shown = await notifyNotesReady('/tmp/autodoc-tests', 'meeting-123')

    expect(shown).toBe(false)
    expect(mocks.encryptJSON).not.toHaveBeenCalled()
    expect(mocks.showNotificationWindow).not.toHaveBeenCalled()
  })

  it('does not persist the dedupe marker when showing the notification fails', async () => {
    mocks.readMetadata.mockResolvedValue({
      sourceName: 'Weekly Sync',
      startedAt: 1,
      stoppedAt: 2,
      durationSeconds: 60
    })
    mocks.showNotificationWindow.mockImplementation(() => {
      throw new Error('display failed')
    })

    await expect(notifyNotesReady('/tmp/autodoc-tests', 'meeting-123')).rejects.toThrow(
      'display failed'
    )

    expect(mocks.encryptJSON).not.toHaveBeenCalled()
  })
})
