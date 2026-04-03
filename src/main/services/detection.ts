import { BrowserWindow, desktopCapturer } from 'electron'
import { execFile } from 'child_process'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'
import { getActiveCaptureProcessIdsMac } from './mac-meeting-detector'
import { getActiveCaptureProcessIdsWindows } from './windows-meeting-detector'
import { logAutodocFailure } from './autodoc-log'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Suppress pre-start prompts when an event begins within 10 minutes
const AUTO_STOP_GRACE_MS = 30_000 // Wait 30s after mic goes silent before auto-stopping
const AUTO_RECORD_START_GRACE_MS = 15_000 // Suppress duplicate prompts while start is in flight

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
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null
  private autoRecordPendingUntil = 0
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
    hideNotificationWindow()
  }

  private async poll(): Promise<void> {
    try {
      if (this.recordingService.getState().isRecording) {
        this.clearAutoRecordPending()
        const windowClosed = await this.isRecordedWindowClosed()
        if (windowClosed) {
          this.clearAutoStop()
          this.broadcast('detection:auto-stop', { reason: 'window_closed' })
          return
        }

        if (process.platform === 'darwin') {
          const micActive = await this.isMicInUseMac()
          if (micActive) {
            this.clearAutoStop()
          } else if (!this.autoStopTimer) {
            const meetingWindowOpen = await this.isMeetingWindowOpen()
            if (!meetingWindowOpen) {
              this.broadcast('detection:auto-stop', { reason: 'provider_gone' })
              return
            }
            this.scheduleAutoStop('mic_idle')
          }
        } else if (process.platform === 'win32') {
          const provider = await this.getActiveProvider()
          if (provider) {
            this.clearAutoStop()
          } else if (!this.autoStopTimer) {
            this.scheduleAutoStop('provider_gone')
          }
        }

        this.resetProviderState()
        hideNotificationWindow()
        return
      }

      this.clearAutoStop()

      if (this.isAutoRecordPending()) {
        hideNotificationWindow()
        return
      }

      const matchingEvent = this.findInProgressEvent()
      const provider = await this.getActiveProvider()
      const providerSignalKey = provider ? `${provider.id}:mic` : ''
      if (matchingEvent) {
        await this.handleCalendarEvent(matchingEvent, providerSignalKey)
        return
      }

      if (this.hasUpcomingEventSoon()) {
        this.promptedCalendarEventId = null
        this.resetProviderState()
        hideNotificationWindow()
        return
      }

      this.promptedCalendarEventId = null
      await this.handleAdHocDetection(provider, providerSignalKey)
    } catch (err) {
      logAutodocFailure({
        area: 'detection',
        message: 'Meeting detection poll failed',
        error: err,
        context: {
          isRecording: this.recordingService.getState().isRecording,
          providerSignalKey: this.lastProviderSignalKey || null,
        },
      })
    }
  }

  private clearAutoStop(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer)
      this.autoStopTimer = null
    }
  }

  private scheduleAutoStop(reason: 'mic_idle' | 'provider_gone'): void {
    this.autoStopTimer = setTimeout(() => {
      this.autoStopTimer = null
      if (this.recordingService.getState().isRecording) {
        this.broadcast('detection:auto-stop', { reason })
      }
    }, AUTO_STOP_GRACE_MS)
  }

  private async isMeetingWindowOpen(): Promise<boolean> {
    try {
      const { MEETING_APP_PATTERNS } = await import('../../shared/constants')
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
      return sources.some((s) =>
        MEETING_APP_PATTERNS.some(({ pattern }) => pattern.test(s.name))
      )
    } catch {
      return true
    }
  }

  private async isRecordedWindowClosed(): Promise<boolean> {
    const state = this.recordingService.getState()
    if (!state.sourceId || state.sourceId.startsWith('screen:')) {
      return false
    }

    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
      return !sources.some((s) => s.id === state.sourceId)
    } catch {
      return false
    }
  }

  private async handleCalendarEvent(event: CalendarEvent, providerSignalKey: string): Promise<void> {
    if (!providerSignalKey) {
      if (this.lastProviderSignalKey) {
        this.broadcast('detection:mic-inactive', {})
        this.lastProviderSignalKey = ''
      }
      hideNotificationWindow()
      return
    }

    const providerJustActivated = providerSignalKey !== this.lastProviderSignalKey
    this.lastProviderSignalKey = providerSignalKey

    if (!providerJustActivated && this.promptedCalendarEventId === event.id) return

    this.promptedCalendarEventId = event.id
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
      const activeIds = await getActiveCaptureProcessIdsMac()
      return matchProviderFromIds(activeIds)
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
        this.markAutoRecordPending()
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
    if (isAutoRecordEnabled(event.id, event.recurringEventId)) {
      this.markAutoRecordPending()
      this.broadcast('detection:auto-record', {})
      return
    }

    this.showPrompt(event.title)
  }

  private findInProgressEvent(): CalendarEvent | null {
    const now = Date.now()
    const events = this.getCalendarEvents()

    for (const event of events) {
      const isDuring = event.startTime <= now && event.endTime >= now
      if (isDuring) {
        return event
      }
    }

    return null
  }

  private hasUpcomingEventSoon(): boolean {
    const now = Date.now()
    const events = this.getCalendarEvents()

    return events.some((event) => event.startTime > now && event.startTime - now < EVENT_WINDOW_MS)
  }

  private resetProviderState(): void {
    if (this.lastProviderSignalKey) {
      this.broadcast('detection:mic-inactive', {})
      this.lastProviderSignalKey = ''
    }
  }

  private markAutoRecordPending(): void {
    this.autoRecordPendingUntil = Date.now() + AUTO_RECORD_START_GRACE_MS
  }

  private clearAutoRecordPending(): void {
    this.autoRecordPendingUntil = 0
  }

  private isAutoRecordPending(): boolean {
    if (this.autoRecordPendingUntil === 0) return false
    if (Date.now() < this.autoRecordPendingUntil) return true
    this.autoRecordPendingUntil = 0
    return false
  }

  private broadcast(channel: string, payload: Record<string, unknown>): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send(channel, payload)
    }
  }
}
