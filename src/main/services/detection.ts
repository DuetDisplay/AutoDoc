import { BrowserWindow, desktopCapturer } from 'electron'
import { execFile } from 'child_process'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Match if event starts within +/- 10 minutes
const AUTO_STOP_GRACE_MS = 30_000 // Wait 30s after mic goes silent before auto-stopping

export class DetectionService {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private micWasActive = false
  private prompted = false
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private getCalendarEvents: () => CalendarEvent[]

  constructor(
    private recordingService: RecordingService,
    getCalendarEvents: () => CalendarEvent[],
  ) {
    this.getCalendarEvents = getCalendarEvents
  }

  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    this.poll()
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.clearAutoStop()
  }

  dismissPrompt(): void {
    this.prompted = true
    hideNotificationWindow()
  }

  private async poll(): Promise<void> {
    const isRecording = this.recordingService.getState().isRecording
    const micActive = await this.isMicInUse()

    // When recording: watch for meeting end
    if (isRecording) {
      // Check if the recorded window was closed
      const windowClosed = await this.isRecordedWindowClosed()
      if (windowClosed) {
        console.log('Auto-stopping recording — recorded window was closed')
        this.clearAutoStop()
        this.broadcast('detection:auto-stop', {})
        return
      }

      // Mic-based detection as fallback (e.g., recording full screen)
      if (micActive) {
        // Mic still active — cancel any pending auto-stop
        this.clearAutoStop()
      } else if (!this.autoStopTimer) {
        // Mic went silent — check if any meeting app is still open
        const meetingWindowOpen = await this.isMeetingWindowOpen()
        if (!meetingWindowOpen) {
          // No meeting window + mic silent = meeting ended, stop immediately
          console.log('Auto-stopping recording — mic inactive and no meeting window found')
          this.broadcast('detection:auto-stop', {})
          return
        }
        // Meeting window still open but mic silent (probably muted) — start grace period
        console.log('Meeting mic inactive but window still open — auto-stop in 30s unless mic resumes')
        this.autoStopTimer = setTimeout(() => {
          this.autoStopTimer = null
          if (this.recordingService.getState().isRecording) {
            console.log('Auto-stopping recording — meeting appears to have ended')
            this.broadcast('detection:auto-stop', {})
          }
        }, AUTO_STOP_GRACE_MS)
      }
      // Reset detection state while recording
      this.prompted = false
      this.micWasActive = false
      hideNotificationWindow()
      return
    }

    // Not recording: watch for meeting start (mic becomes active)
    this.clearAutoStop()

    if (micActive && !this.micWasActive) {
      this.micWasActive = true
      if (!this.prompted) {
        this.prompted = true
        const matchingEvent = this.findMatchingEvent()
        if (matchingEvent && isAutoRecordEnabled(matchingEvent.googleEventId, matchingEvent.recurringEventId)) {
          // Auto-record: skip prompt, start recording directly
          this.broadcast('detection:auto-record', {})
        } else {
          this.showPrompt()
        }
      }
    } else if (!micActive && this.micWasActive) {
      this.micWasActive = false
      this.prompted = false
      hideNotificationWindow()
      this.broadcast('detection:mic-inactive', {})
    }
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
  }

  /**
   * Check if any known meeting app window is currently open.
   * Used to distinguish "muted" from "meeting ended" when mic goes silent.
   */
  private async isMeetingWindowOpen(): Promise<boolean> {
    try {
      const { MEETING_APP_PATTERNS } = await import('../../shared/constants')
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
      return sources.some((s) =>
        MEETING_APP_PATTERNS.some(({ pattern }) => pattern.test(s.name))
      )
    } catch {
      return true // Assume open if we can't check (safer — avoids false stops)
    }
  }

  /**
   * Check if the window being recorded has been closed.
   * Only applies when recording a specific window (not full screen).
   */
  private async isRecordedWindowClosed(): Promise<boolean> {
    const state = this.recordingService.getState()
    if (!state.sourceId || state.sourceId.startsWith('screen:')) {
      // Recording full screen — can't detect window closure
      return false
    }

    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
      return !sources.some((s) => s.id === state.sourceId)
    } catch {
      return false
    }
  }

  private isMicInUse(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'assertions'], { timeout: 2000 }, (err, stdout) => {
        if (err) {
          resolve(false)
          return
        }
        resolve(stdout.includes('audio-in'))
      })
    })
  }

  private showPrompt(): void {
    const matchingEvent = this.findMatchingEvent()

    const title = matchingEvent?.title ?? 'Meeting detected'
    const body = 'Would you like to start AI notes?'

    // Show floating overlay window
    showNotificationWindow({
      title,
      body,
      onRecord: () => {
        // Bring main window to front and auto-start recording
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          win.show()
          win.focus()
        }
        this.broadcast('detection:auto-record', {})
      },
      onDismiss: () => {
        this.prompted = true
      },
    })

  }

  private findMatchingEvent(): CalendarEvent | null {
    const now = Date.now()
    const events = this.getCalendarEvents()

    for (const event of events) {
      const isNearStart = Math.abs(event.startTime - now) < EVENT_WINDOW_MS
      const isDuring = event.startTime <= now && event.endTime >= now
      if (isNearStart || isDuring) {
        return event
      }
    }

    return null
  }

  private broadcast(channel: string, payload: Record<string, unknown>): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send(channel, payload)
    }
  }
}
