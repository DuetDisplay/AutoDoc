import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'
import { getActiveCaptureProcessIdsWindows } from './windows-meeting-detector'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Match if event starts within +/- 10 minutes

interface MeetingProvider {
  id: string
  name: string
  identifiers: readonly string[]
}

const MEETING_PROVIDERS: readonly MeetingProvider[] = [
  { id: 'zoom', name: 'Zoom', identifiers: ['zoom', 'zoom.exe', 'us.zoom.xos'] },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    identifiers: [
      'teams',
      'teams.exe',
      'ms-teams',
      'ms-teams.exe',
      'com.microsoft.teams',
      'com.microsoft.teams2',
    ],
  },
  { id: 'slack', name: 'Slack', identifiers: ['slack', 'slack.exe', 'com.tinyspeck.slackmacgap'] },
  { id: 'webex', name: 'Webex', identifiers: ['webex', 'webex.exe', 'ciscowebexstart', 'com.cisco.webexmeetingsapp'] },
  { id: 'discord', name: 'Discord', identifiers: ['discord', 'discord.exe', 'com.hnc.discord'] },
]

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function matchProviderFromIds(ids: string[]): MeetingProvider | null {
  for (const id of ids) {
    const normalizedId = normalize(id)
    const matched = MEETING_PROVIDERS.find((provider) => provider.identifiers.includes(normalizedId))
    if (matched) return matched
  }

  return null
}

export class DetectionService {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastProviderSignalKey = ''
  private promptedCalendarEventId: string | null = null
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
    hideNotificationWindow()
  }

  private async poll(): Promise<void> {
    if (this.recordingService.getState().isRecording) {
      this.resetProviderState()
      hideNotificationWindow()
      return
    }

    const matchingEvent = this.findMatchingEvent()
    const provider = await this.getActiveProvider()
    const providerSignalKey = provider ? `${provider.id}:mic` : ''
    if (matchingEvent) {
      await this.handleCalendarEvent(matchingEvent, providerSignalKey)
      return
    }

    this.promptedCalendarEventId = null
    await this.handleAdHocDetection(provider, providerSignalKey)
  }

  private async handleCalendarEvent(event: CalendarEvent, providerSignalKey: string): Promise<void> {
    if (providerSignalKey) {
      const providerJustActivated = providerSignalKey !== this.lastProviderSignalKey
      this.lastProviderSignalKey = providerSignalKey

      if (providerJustActivated && this.promptedCalendarEventId === event.googleEventId) {
        this.promptForCalendarEvent(event)
        return
      }
    } else if (this.lastProviderSignalKey) {
      this.broadcast('detection:mic-inactive', {})
      this.lastProviderSignalKey = ''
    }

    if (this.promptedCalendarEventId === event.googleEventId) return

    this.promptedCalendarEventId = event.googleEventId
    this.promptForCalendarEvent(event)
  }

  private async handleAdHocDetection(provider: MeetingProvider | null, providerSignalKey: string): Promise<void> {
    if (!provider) {
      this.resetProviderState()
      hideNotificationWindow()
      return
    }

    if (providerSignalKey === this.lastProviderSignalKey) return

    this.lastProviderSignalKey = providerSignalKey
    this.showPrompt(provider.name)
  }

  private async getActiveProvider(): Promise<MeetingProvider | null> {
    if (process.platform === 'darwin') {
      return (await this.isMicInUseMac())
        ? { id: 'mac-mic', name: 'Meeting detected', identifiers: [] }
        : null
    }

    if (process.platform === 'win32') {
      const activeIds = await getActiveCaptureProcessIdsWindows()
      return matchProviderFromIds(activeIds)
    }

    return null
  }

  private isMicInUseMac(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'assertions'], { timeout: 2_000 }, (err, stdout) => {
        if (err) {
          resolve(false)
          return
        }
        resolve(stdout.includes('audio-in'))
      })
    })
  }

  private showPrompt(title: string): void {
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
      onDismiss: () => {},
    })
  }

  private promptForCalendarEvent(event: CalendarEvent): void {
    if (isAutoRecordEnabled(event.googleEventId, event.recurringEventId)) {
      this.broadcast('detection:auto-record', {})
      return
    }

    this.showPrompt(event.title)
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

  private resetProviderState(): void {
    if (this.lastProviderSignalKey) {
      this.broadcast('detection:mic-inactive', {})
      this.lastProviderSignalKey = ''
    }
  }

  private broadcast(channel: string, payload: Record<string, unknown>): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send(channel, payload)
    }
  }
}
