import { BrowserWindow, desktopCapturer } from 'electron'
import { execFile } from 'child_process'
import { BROWSER_PATTERNS, MEETING_APP_PATTERNS } from '../../shared/constants'
import type { CalendarEvent } from '../../shared/types'
import type { RecordingService } from './recording'
import { showNotificationWindow, hideNotificationWindow } from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'
import { getActiveCaptureProcessIdsMac } from './mac-meeting-detector'
import { getActiveCaptureProcessIdsWindows } from './windows-meeting-detector'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { focusMainWindow } from './main-window'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Suppress pre-start prompts when an event begins within 10 minutes
const AUTO_STOP_GRACE_MS = 30_000
const AUTO_STOP_CONFIRM_MS = 6_000
const WINDOW_CLOSED_CONFIRM_MS = 3_000
const AUTO_RECORD_START_GRACE_MS = 15_000 // Suppress duplicate prompts while start is in flight
const WINDOW_MISSING_POLLS_THRESHOLD = 2
const PROVIDER_MISSING_POLLS_THRESHOLD = 2
const MEETING_WINDOW_MISSING_POLLS_THRESHOLD = 3

type AutoStopReason = 'window_closed' | 'mic_idle' | 'provider_gone'

interface AutoStopPendingState {
  reason: AutoStopReason
  startedAt: number
}

interface AutoStopSnapshot {
  sourceType: 'window' | 'screen'
  providerDetected: boolean
  meetingWindowVisible: boolean
  windowMissingPolls: number
  providerMissingPolls: number
  micSilentPolls: number
}

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
  private autoRecordPendingUntil = 0
  private pendingAutoStop: AutoStopPendingState | null = null
  private windowMissingPolls = 0
  private providerMissingPolls = 0
  private meetingWindowMissingPolls = 0
  private micSilentPolls = 0
  private wasRecording = false
  private loggedFocusSwitchSuppression = false
  private loggedLingeringWindowBlock = false
  private suppressedProviderSignalKey = ''
  private suppressedCalendarEventId: string | null = null
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
    this.resetAutoStopState()
  }

  dismissPrompt(): void {
    hideNotificationWindow()
  }

  private async poll(): Promise<void> {
    try {
      if (this.recordingService.getState().isRecording) {
        this.wasRecording = true
        this.clearAutoRecordPending()
        const windowClosed = await this.isRecordedWindowClosed()
        const provider = await this.getActiveProvider()
        const providerDetected = provider !== null
        const meetingWindowVisible = await this.isMeetingWindowOpen()
        const micActive = process.platform === 'darwin'
          ? await this.isMicInUseMac()
          : null

        this.updateAutoStopCounters({
          windowClosed,
          providerDetected,
          meetingWindowVisible,
          micActive,
        })

        const snapshot = this.getAutoStopSnapshot(providerDetected, meetingWindowVisible)
        this.recognizeAutoStopEdgeCases(snapshot)
        const reason = this.getAutoStopReason(snapshot)
        if (reason) {
          this.maybeBroadcastAutoStop(reason, snapshot)
        } else {
          this.cancelPendingAutoStop(snapshot)
        }

        hideNotificationWindow()
        return
      }

      this.resetAutoStopState()

      if (this.isAutoRecordPending()) {
        hideNotificationWindow()
        return
      }

      const matchingEvent = this.findInProgressEvent()
      const provider = await this.getActiveProvider()
      const providerSignalKey = provider ? `${provider.id}:mic` : ''
      if (this.wasRecording) {
        this.suppressCurrentMeetingSignal(providerSignalKey, matchingEvent?.id ?? null)
        this.wasRecording = false
      }
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

  private resetAutoStopState(): void {
    this.pendingAutoStop = null
    this.windowMissingPolls = 0
    this.providerMissingPolls = 0
    this.meetingWindowMissingPolls = 0
    this.micSilentPolls = 0
    this.loggedFocusSwitchSuppression = false
    this.loggedLingeringWindowBlock = false
  }

  private updateAutoStopCounters(params: {
    windowClosed: boolean
    providerDetected: boolean
    meetingWindowVisible: boolean
    micActive: boolean | null
  }): void {
    this.windowMissingPolls = params.windowClosed ? this.windowMissingPolls + 1 : 0
    this.providerMissingPolls = params.providerDetected ? 0 : this.providerMissingPolls + 1
    this.meetingWindowMissingPolls = params.meetingWindowVisible ? 0 : this.meetingWindowMissingPolls + 1

    if (params.micActive === null) {
      this.micSilentPolls = 0
    } else {
      this.micSilentPolls = params.micActive ? 0 : this.micSilentPolls + 1
    }
  }

  private getAutoStopSnapshot(
    providerDetected: boolean,
    meetingWindowVisible: boolean,
  ): AutoStopSnapshot {
    return {
      sourceType: this.getRecordedSourceType(),
      providerDetected,
      meetingWindowVisible,
      windowMissingPolls: this.windowMissingPolls,
      providerMissingPolls: this.providerMissingPolls,
      micSilentPolls: this.micSilentPolls,
    }
  }

  private getAutoStopReason(snapshot: AutoStopSnapshot): AutoStopReason | null {
    const micIdleStrong = this.micSilentPolls * POLL_INTERVAL_MS >= AUTO_STOP_GRACE_MS
    const meetingWindowGoneStrong = this.meetingWindowMissingPolls >= MEETING_WINDOW_MISSING_POLLS_THRESHOLD
    const providerGoneStrong = this.providerMissingPolls >= PROVIDER_MISSING_POLLS_THRESHOLD
    const windowGoneStrong = snapshot.sourceType === 'window' && this.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD
    const browserLikeSource = this.isBrowserLikeSource()

    if (windowGoneStrong && meetingWindowGoneStrong) {
      return 'window_closed'
    }

    if (micIdleStrong && (providerGoneStrong || meetingWindowGoneStrong)) {
      return 'mic_idle'
    }

    if (providerGoneStrong && windowGoneStrong) {
      return 'provider_gone'
    }

    if (providerGoneStrong) {
      if (snapshot.sourceType === 'screen' || browserLikeSource) {
        if (micIdleStrong || meetingWindowGoneStrong) {
          return 'provider_gone'
        }
      } else if (micIdleStrong || meetingWindowGoneStrong) {
        return 'provider_gone'
      }
    }

    return null
  }

  private recognizeAutoStopEdgeCases(snapshot: AutoStopSnapshot): void {
    const meetingId = this.recordingService.getState().meetingId ?? undefined
    const micIdleStrong = this.micSilentPolls * POLL_INTERVAL_MS >= AUTO_STOP_GRACE_MS

    if (
      !this.loggedFocusSwitchSuppression
      && snapshot.sourceType === 'window'
      && snapshot.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD
      && snapshot.meetingWindowVisible
    ) {
      this.loggedFocusSwitchSuppression = true
      logAutodocEvent({
        area: 'detection',
        message: 'Auto-stop suppressed — possible focus or desktop switch while meeting remains visible',
        meetingId,
        context: { ...snapshot },
      })
    }

    if (
      !this.loggedLingeringWindowBlock
      && snapshot.sourceType === 'window'
      && !snapshot.providerDetected
      && snapshot.providerMissingPolls >= PROVIDER_MISSING_POLLS_THRESHOLD
      && snapshot.meetingWindowVisible
      && snapshot.windowMissingPolls === 0
    ) {
      this.loggedLingeringWindowBlock = true
      logAutodocEvent({
        area: 'detection',
        message: micIdleStrong
          ? 'Auto-stop blocked — meeting may be over, but the meeting window is still visible'
          : 'Auto-stop blocked — meeting provider disappeared, but the meeting window is still visible',
        meetingId,
        context: { ...snapshot },
      })
    }
  }

  private maybeBroadcastAutoStop(reason: AutoStopReason, snapshot: AutoStopSnapshot): void {
    if (!this.recordingService.getState().isRecording) return

    if (!this.pendingAutoStop || this.pendingAutoStop.reason !== reason) {
      this.pendingAutoStop = {
        reason,
        startedAt: Date.now(),
      }
      return
    }

    if (Date.now() - this.pendingAutoStop.startedAt < this.getAutoStopConfirmMs(reason, snapshot)) {
      return
    }

    this.pendingAutoStop = null
    logAutodocEvent({
      area: 'detection',
      message: 'Auto-stop confirmed after sustained missing meeting signals',
      meetingId: this.recordingService.getState().meetingId ?? undefined,
      context: {
        reason,
        ...snapshot,
      },
    })
    this.broadcast('detection:auto-stop', {
      reason,
      ...snapshot,
    })
  }

  private cancelPendingAutoStop(snapshot: AutoStopSnapshot): void {
    if (!this.pendingAutoStop) return

    const pending = this.pendingAutoStop
    this.pendingAutoStop = null
    const recoveredSignals = this.getRecoveredSignals(snapshot)
    logAutodocEvent({
      area: 'detection',
      message: 'Auto-stop cancelled after meeting signals recovered',
      meetingId: this.recordingService.getState().meetingId ?? undefined,
      context: {
        reason: pending.reason,
        ...snapshot,
        recoveredSignals,
      },
    })
    this.broadcast('detection:auto-stop-cancelled', {
      reason: pending.reason,
      ...snapshot,
      recoveredSignals,
    })
  }

  private getRecoveredSignals(snapshot: AutoStopSnapshot): string[] {
    const recovered: string[] = []

    if (snapshot.windowMissingPolls === 0 && snapshot.sourceType === 'window') {
      recovered.push('window_visible')
    }

    if (snapshot.providerDetected) {
      recovered.push('provider_detected')
    }

    if (snapshot.meetingWindowVisible) {
      recovered.push('meeting_window_visible')
    }

    if (snapshot.micSilentPolls === 0 && process.platform === 'darwin') {
      recovered.push('mic_active')
    }

    return recovered.length > 0 ? recovered : ['signal_recovered']
  }

  private getAutoStopConfirmMs(reason: AutoStopReason, snapshot: AutoStopSnapshot): number {
    if (reason === 'window_closed') {
      return snapshot.providerDetected ? WINDOW_CLOSED_CONFIRM_MS : 0
    }

    if (reason === 'provider_gone' && snapshot.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD) {
      return 0
    }

    return AUTO_STOP_CONFIRM_MS
  }

  private async isMeetingWindowOpen(): Promise<boolean> {
    try {
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

  private getRecordedSourceType(): 'window' | 'screen' {
    const sourceId = this.recordingService.getState().sourceId
    return sourceId?.startsWith('screen:') ? 'screen' : 'window'
  }

  private isBrowserLikeSource(): boolean {
    const sourceName = this.recordingService.getState().sourceName ?? ''
    return BROWSER_PATTERNS.some((pattern) => pattern.test(sourceName))
      || /\b(safari|chrome|firefox|edge|brave|arc|opera|vivaldi)\b/i.test(sourceName)
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

    if (this.shouldSuppressPrompt(providerSignalKey, event.id)) {
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

    if (this.shouldSuppressPrompt(providerSignalKey, null)) {
      this.lastProviderSignalKey = providerSignalKey
      return
    }

    if (providerSignalKey === this.lastProviderSignalKey) return

    this.lastProviderSignalKey = providerSignalKey
    this.showPrompt(provider.name, provider.id)
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

  private showPrompt(title: string, providerId: string | null): void {
    const body = 'Would you like to start AI notes?'

    showNotificationWindow({
      title,
      body,
      onRecord: () => {
        this.markAutoRecordPending()
        focusMainWindow()
        this.broadcast('detection:auto-record', { providerId, hasCalendarEvent: false })
      },
      onDismiss: () => {},
    })
  }

  private promptForCalendarEvent(event: CalendarEvent): void {
    if (isAutoRecordEnabled(event.id, event.recurringEventId)) {
      this.markAutoRecordPending()
      this.broadcast('detection:auto-record', {
        providerId: inferProviderFromMeetingUrl(event.meetingUrl),
        hasCalendarEvent: true,
      })
      return
    }

    this.showPrompt(event.title, inferProviderFromMeetingUrl(event.meetingUrl))
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
    this.suppressedProviderSignalKey = ''
    this.suppressedCalendarEventId = null
  }

  private suppressCurrentMeetingSignal(providerSignalKey: string, eventId: string | null): void {
    this.suppressedProviderSignalKey = providerSignalKey
    this.suppressedCalendarEventId = eventId
    if (providerSignalKey) {
      this.lastProviderSignalKey = providerSignalKey
    }
    if (eventId) {
      this.promptedCalendarEventId = eventId
    }
  }

  private shouldSuppressPrompt(providerSignalKey: string, eventId: string | null): boolean {
    if (!this.suppressedProviderSignalKey) {
      return false
    }

    if (providerSignalKey !== this.suppressedProviderSignalKey) {
      this.suppressedProviderSignalKey = ''
      this.suppressedCalendarEventId = null
      return false
    }

    if (eventId === null) {
      return true
    }

    if (this.suppressedCalendarEventId === eventId) {
      return true
    }

    this.suppressedCalendarEventId = null
    return false
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

function inferProviderFromMeetingUrl(meetingUrl: string | null): string | null {
  if (!meetingUrl) return null

  if (/zoom\.us/i.test(meetingUrl)) return 'zoom'
  if (/teams\.microsoft\.com/i.test(meetingUrl)) return 'teams'
  if (/meet\.google\.com/i.test(meetingUrl)) return 'google_meet'
  if (/webex\.com/i.test(meetingUrl)) return 'webex'
  if (/slack\.com/i.test(meetingUrl)) return 'slack'

  return null
}
