import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Match if event starts within +/- 10 minutes

// Known meeting app process names (from AutodocRecorder MeetingDetector.cpp providerRules)
const MEETING_PROVIDERS: { id: string; name: string; executables: string[] }[] = [
  { id: 'zoom', name: 'Zoom', executables: ['zoom.exe'] },
  { id: 'teams', name: 'Microsoft Teams', executables: ['teams.exe', 'ms-teams.exe'] },
  { id: 'slack', name: 'Slack', executables: ['slack.exe'] },
  { id: 'webex', name: 'Webex', executables: ['webex.exe', 'ciscowebexstart.exe'] },
  { id: 'discord', name: 'Discord', executables: ['discord.exe'] },
]

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
        const matchingEvent = this.findMatchingEvent()
        if (matchingEvent && isAutoRecordEnabled(matchingEvent.googleEventId, matchingEvent.recurringEventId)) {
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

  private isMicInUse(): Promise<boolean> {
    if (process.platform === 'darwin') {
      return this.isMicInUseMac()
    }
    if (process.platform === 'win32') {
      return this.isMeetingAppRunningWindows()
    }
    return Promise.resolve(false)
  }

  private isMicInUseMac(): Promise<boolean> {
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

  /**
   * Check if any known meeting app is running on Windows.
   * Uses tasklist to enumerate running processes and matches against known
   * meeting provider executables (Zoom, Teams, Slack, Webex, Discord).
   */
  private isMeetingAppRunningWindows(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'tasklist',
        ['/FO', 'CSV', '/NH'],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(false)
            return
          }
          const lowerOutput = stdout.toLowerCase()
          for (const provider of MEETING_PROVIDERS) {
            for (const exe of provider.executables) {
              if (lowerOutput.includes(exe.toLowerCase())) {
                resolve(true)
                return
              }
            }
          }
          resolve(false)
        },
      )
    })
  }

  private showPrompt(): void {
    const matchingEvent = this.findMatchingEvent()

    const title = matchingEvent?.title ?? 'Meeting detected'
    const body = 'Would you like to start AI notes?'

    showNotificationWindow({
      title,
      body,
      onRecord: () => {
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
