import { desktopCapturer, Notification, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { MEETING_APP_PATTERNS } from '../../shared/constants'
import type { CalendarEvent, RecordingSource } from '../../shared/types'
import type { RecordingService } from './recording'

const POLL_INTERVAL_MS = 5_000
const EVENT_WINDOW_MS = 10 * 60_000 // Match if event starts within +/- 10 minutes

export class DetectionService {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private micWasActive = false
  private notificationShown = false
  private pendingNotification: Notification | null = null
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
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async poll(): Promise<void> {
    if (this.recordingService.getState().isRecording) return

    const micActive = await this.isMicInUse()

    if (micActive && !this.micWasActive) {
      // Mic just became active
      this.micWasActive = true
      if (!this.notificationShown) {
        this.notificationShown = true
        await this.promptToRecord()
      }
    } else if (!micActive && this.micWasActive) {
      // Mic deactivated — reset for next detection
      this.micWasActive = false
      this.notificationShown = false
    }
  }

  private isMicInUse(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'assertions'], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(false)
          return
        }
        resolve(stdout.includes('audio-in'))
      })
    })
  }

  private async promptToRecord(): Promise<void> {
    // Try to find a meeting window for context
    const sources = await this.getSources()
    const meetingSource = this.detectMeetingWindow(sources)
    const matchingEvent = this.findMatchingEvent()

    const autoRecord = matchingEvent?.autoRecord ?? false

    if (autoRecord && meetingSource) {
      this.startRecording(meetingSource.id, matchingEvent!.title)
      return
    }

    const title = matchingEvent
      ? `${matchingEvent.title} is starting`
      : 'Microphone active'
    const body = matchingEvent
      ? 'Start recording this meeting?'
      : meetingSource
        ? `${meetingSource.name} — Start recording?`
        : 'Are you in a meeting? Start recording?'

    const sourceId = meetingSource?.id ?? null
    const sourceName = matchingEvent?.title ?? meetingSource?.name ?? 'Meeting'

    const notification = new Notification({
      title,
      body,
      silent: false,
    })

    notification.on('click', () => {
      if (sourceId) {
        this.startRecording(sourceId, sourceName)
      } else {
        // No meeting window found — bring app to front so user can pick a source
        this.focusApp()
      }
      this.pendingNotification = null
    })

    notification.on('close', () => {
      this.pendingNotification = null
    })

    notification.show()
    this.pendingNotification = notification
  }

  private startRecording(sourceId: string, sourceName: string): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('detection:start-recording', { sourceId, sourceName })
    }
  }

  private focusApp(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
    }
  }

  private async getSources(): Promise<RecordingSource[]> {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1, height: 1 },
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnailDataUrl: '',
    }))
  }

  private detectMeetingWindow(sources: RecordingSource[]): RecordingSource | null {
    for (const { pattern } of MEETING_APP_PATTERNS) {
      const match = sources.find((s) => pattern.test(s.name))
      if (match) return match
    }
    return null
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
}
