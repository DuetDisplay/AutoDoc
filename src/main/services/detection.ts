import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Match if event starts within +/- 10 minutes

export class DetectionService {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private micWasActive = false
  private prompted = false
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
  }

  dismissPrompt(): void {
    this.prompted = true
    hideNotificationWindow()
  }

  private async poll(): Promise<void> {
    if (this.recordingService.getState().isRecording) {
      this.prompted = false
      this.micWasActive = false
      hideNotificationWindow()
      return
    }

    const micActive = await this.isMicInUse()

    if (micActive && !this.micWasActive) {
      this.micWasActive = true
      if (!this.prompted) {
        this.prompted = true
        this.showPrompt()
      }
    } else if (!micActive && this.micWasActive) {
      this.micWasActive = false
      this.prompted = false
      hideNotificationWindow()
      this.broadcast('detection:mic-inactive', {})
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
