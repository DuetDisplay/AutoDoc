import { BrowserWindow, desktopCapturer } from 'electron'
import { execFile } from 'child_process'
import { BROWSER_PATTERNS, MEETING_APP_PATTERNS } from '../../shared/constants'
import type { CalendarEvent, DetectionAutoRecordPayload } from '../../shared/types'
import { selectActiveCalendarEvent } from '../../shared/calendar-selection'
import type { RecordingService } from './recording'
import {
  showNotificationWindow,
  hideNotificationWindow,
  type NotificationKind
} from '../notification-window'
import { isAutoRecordEnabled } from './auto-record-store'
import { getActiveCaptureProcessIdsMac } from './mac-meeting-detector'
import { getActiveCaptureProcessIdsWindows } from './windows-meeting-detector'
import { logAutodocEvent, logAutodocFailure } from './autodoc-log'
import { getE2EDetectionState } from './e2e-fixtures'
import { focusMainWindow, getMainWindow } from './main-window'

const POLL_INTERVAL_MS = 3_000
const EVENT_WINDOW_MS = 10 * 60_000 // Suppress pre-start prompts when an event begins within 10 minutes
const AUTO_STOP_GRACE_MS = 30_000
const AUTO_STOP_CONFIRM_MS = 6_000
const WINDOW_CLOSED_CONFIRM_MS = 3_000
const AUTO_RECORD_START_GRACE_MS = 15_000 // Suppress duplicate prompts while start is in flight
const WINDOW_MISSING_POLLS_THRESHOLD = 2
const PROVIDER_MISSING_POLLS_THRESHOLD = 2
const MEETING_WINDOW_MISSING_POLLS_THRESHOLD = 3
const isE2E = process.env.AUTODOC_E2E === '1'

type BannerKind = 'start_prompt' | 'select_window' | 'recording_started'
type DetectionDecision = 'skip' | 'prompt' | 'auto_record'

type AutoStopReason = 'window_closed' | 'mic_idle' | 'provider_gone'

interface AutoStopPendingState {
  reason: AutoStopReason
  startedAt: number
}

interface AutoStopSnapshot {
  sourceType: 'window' | 'screen'
  providerDetected: boolean
  meetingWindowVisible: boolean
  strongMeetingWindowVisible: boolean
  windowMissingPolls: number
  providerMissingPolls: number
  micSilentPolls: number
}

interface MeetingWindowObservation {
  visible: boolean
  strongVisible: boolean
  diagnostics?: Record<string, unknown>
}

interface MeetingProviderObservation {
  provider: MeetingProvider | null
  activeIds: string[]
  detector: 'mac_helper' | 'windows_helper' | 'unsupported'
}

interface MeetingProvider {
  id: string
  name: string
  identifiers: readonly string[]
  titleTokens: readonly string[]
  genericWindowTitles: readonly string[]
}

const MEETING_PROVIDERS: readonly MeetingProvider[] = [
  {
    id: 'zoom',
    name: 'Zoom',
    identifiers: ['zoom', 'zoom.exe', 'us.zoom.xos'],
    titleTokens: ['zoom'],
    genericWindowTitles: ['zoom', 'zoom workplace', 'zoom meetings']
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    identifiers: [
      'teams',
      'teams.exe',
      'ms-teams',
      'ms-teams.exe',
      'com.microsoft.teams',
      'com.microsoft.teams2'
    ],
    titleTokens: ['microsoft', 'teams'],
    genericWindowTitles: ['teams', 'microsoft teams']
  },
  {
    id: 'slack',
    name: 'Slack',
    identifiers: ['slack', 'slack.exe', 'com.tinyspeck.slackmacgap'],
    titleTokens: ['slack'],
    genericWindowTitles: ['slack']
  },
  {
    id: 'webex',
    name: 'Webex',
    identifiers: ['webex', 'webex.exe', 'ciscowebexstart', 'com.cisco.webexmeetingsapp'],
    titleTokens: ['webex', 'cisco'],
    genericWindowTitles: ['webex', 'webex meetings', 'cisco webex meetings']
  },
  {
    id: 'discord',
    name: 'Discord',
    identifiers: ['discord', 'discord.exe', 'com.hnc.discord'],
    titleTokens: ['discord'],
    genericWindowTitles: ['discord']
  }
]

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function matchProviderFromIds(ids: string[]): MeetingProvider | null {
  for (const id of ids) {
    const normalizedId = normalize(id)
    const matched = MEETING_PROVIDERS.find((provider) =>
      provider.identifiers.includes(normalizedId)
    )
    if (matched) return matched
  }

  return null
}

function getMeetingProviderById(providerId: string | null | undefined): MeetingProvider | null {
  if (!providerId) return null
  return MEETING_PROVIDERS.find((provider) => provider.id === providerId) ?? null
}

function tokenizeTitle(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isGenericProviderWindowTitle(
  name: string | null | undefined,
  providerId: string | null | undefined
): boolean {
  if (!name) return false
  const provider = getMeetingProviderById(providerId)
  if (!provider) return false

  return provider.genericWindowTitles.includes(normalize(name))
}

function getMeaningfulTitleTokens(
  name: string | null | undefined,
  providerId: string | null | undefined
): string[] {
  if (!name) return []

  const provider = getMeetingProviderById(providerId)
  const providerTokens = new Set(provider?.titleTokens ?? [])
  return tokenizeTitle(name).filter((token) => !providerTokens.has(token))
}

function hasTrackedMeetingTitleContinuity(
  currentName: string | null | undefined,
  trackedName: string | null | undefined,
  providerId: string | null | undefined
): boolean {
  if (!currentName || !trackedName) return true

  const normalizedCurrent = normalize(currentName)
  const normalizedTracked = normalize(trackedName)
  if (normalizedCurrent === normalizedTracked) {
    return true
  }

  const trackedWasGeneric = isGenericProviderWindowTitle(trackedName, providerId)
  const currentIsGeneric = isGenericProviderWindowTitle(currentName, providerId)
  if (!trackedWasGeneric && currentIsGeneric) {
    return false
  }

  const trackedTokens = getMeaningfulTitleTokens(trackedName, providerId)
  if (trackedTokens.length === 0) {
    return true
  }

  const currentTokens = new Set(getMeaningfulTitleTokens(currentName, providerId))
  return trackedTokens.some((token) => currentTokens.has(token))
}

// Electron reports a minimized Windows window as focused but not visible, so focus alone does
// not mean the user can see AutoDoc. Only a visible, un-minimized, focused window counts.
function isMainWindowForegrounded(): boolean {
  const mainWindow = getMainWindow()
  return Boolean(
    mainWindow && mainWindow.isFocused() && mainWindow.isVisible() && !mainWindow.isMinimized()
  )
}

function truncateNoticeTitle(title: string, maxLength = 56): string {
  const trimmed = title.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`
}

export class DetectionService {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastProviderSignalKey = ''
  private promptedCalendarEventId: string | null = null
  private autoRecordPendingUntil = 0
  private autoRecordRequestId = 0
  private pendingAutoRecord: {
    payload: DetectionAutoRecordPayload
    title: string
    confirmed: boolean
  } | null = null
  // The renderer reports that its silent start finished only after the capture is live, which
  // can take longer than several polls; the pending request is cleared by then, so keep the last
  // unconfirmed request until its notice is shown, a newer request replaces it, or recording ends.
  private unconfirmedAutoRecord: {
    requestId: number
    title: string
    eventId: string | null
    providerId: string | null
  } | null = null
  private recordingStartedNoticeVisible = false
  private sourceSelectionPending = false
  private pendingAutoStop: AutoStopPendingState | null = null
  private windowMissingPolls = 0
  private providerMissingPolls = 0
  private meetingWindowMissingPolls = 0
  private micSilentPolls = 0
  private wasRecording = false
  private loggedFocusSwitchSuppression = false
  private loggedLingeringWindowBlock = false
  private loggedStrongMeetingProviderGuardBlock = false
  private loggedStrongMeetingMicIdleGuardBlock = false
  private lastAutoStopSignalLogKey = ''
  // Diagnostic keys so each observation or decision is logged once on change, not every poll.
  private lastProviderObservationLogKey: string | null = null
  private lastProviderObservationId: string | null = null
  private lastCalendarCandidatesLogKey: string | null = null
  private lastDecisionLogKey = ''
  private suppressedProviderSignalKey = ''
  private suppressedCalendarEventId: string | null = null
  private debugNowOffsetMs = 0
  private getCalendarEvents: () => CalendarEvent[]

  constructor(
    private recordingService: RecordingService,
    getCalendarEvents: () => CalendarEvent[],
    private stopRecording: () => Promise<void> = async () => {}
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
    this.clearAutoRecordPending()
    this.unconfirmedAutoRecord = null
    this.hideBanner('meeting-detection', 'service_stopped')
    this.hideRecordingStartedNotice('service_stopped')
  }

  // Called by the renderer after a silent auto-record start succeeded. The notice is only for
  // starts the user did not confirm, so they always know AutoDoc is recording and can stop it.
  showAutoRecordStartedNotice(requestId: number): void {
    const request = this.unconfirmedAutoRecord
    if (!request || request.requestId !== requestId) return
    if (!this.recordingService.getState().isRecording) return
    this.unconfirmedAutoRecord = null
    // A quick Stop must still count as a manual stop before the next poll sees the recording.
    this.wasRecording = true
    const displayTitle = truncateNoticeTitle(request.title)
    logAutodocEvent({
      area: 'detection',
      message: 'Auto-record started notice shown',
      context: { requestId }
    })
    this.recordingStartedNoticeVisible = true
    this.showBanner(
      'recording_started',
      { requestId, eventId: request.eventId, providerId: request.providerId },
      {
        title: displayTitle,
        body: 'AI notes started. This meeting is being recorded.',
        primaryActionLabel: 'Stop',
        kind: 'recording-started',
        autoDismissMs: 15_000,
        suppressAppActivationWhileVisible: true,
        onPrimaryAction: () => {
          this.recordingStartedNoticeVisible = false
          logAutodocEvent({
            area: 'detection',
            message: 'Auto-record stopped from notice',
            context: { requestId }
          })
          this.stopRecording().catch((error) => {
            logAutodocFailure({
              area: 'detection',
              message: 'Could not stop auto-record from notice',
              error,
              context: { requestId }
            })
          })
        },
        onDismiss: () => {
          this.recordingStartedNoticeVisible = false
        }
      }
    )
  }

  private hideRecordingStartedNotice(reason = 'recording_stopped'): void {
    if (!this.recordingStartedNoticeVisible) return
    this.recordingStartedNoticeVisible = false
    this.hideBanner('recording-started', reason)
  }

  dismissPrompt(): void {
    this.clearAutoRecordPending()
    this.hideBanner('meeting-detection', 'renderer_dismiss')
  }

  // Wraps showNotificationWindow so every banner logs how it was shown and how it ended.
  // Context holds ids and booleans only; titles are deliberately never logged.
  private showBanner(
    bannerKind: BannerKind,
    context: Record<string, unknown>,
    options: Parameters<typeof showNotificationWindow>[0]
  ): void {
    const base = { bannerKind, notificationKind: options.kind ?? null, ...context }
    logAutodocEvent({ area: 'detection', message: 'Notification banner shown', context: base })
    showNotificationWindow({
      ...options,
      onPrimaryAction: () => {
        logAutodocEvent({
          area: 'detection',
          message: 'Notification banner primary action clicked',
          context: base
        })
        options.onPrimaryAction()
      },
      onDismiss: (reason) => {
        logAutodocEvent({
          area: 'detection',
          message:
            reason === 'timeout'
              ? 'Notification banner auto-dismissed by timeout'
              : 'Notification banner dismissed by user',
          context: base
        })
        options.onDismiss(reason)
      },
      onHidden: (reason) => {
        logAutodocEvent({
          area: 'detection',
          message: 'Notification banner hidden by app',
          context: { ...base, reason }
        })
      }
    })
  }

  private hideBanner(kind: NotificationKind, reason: string): void {
    hideNotificationWindow(kind, reason)
  }

  private logProviderObservation(observation: MeetingProviderObservation): void {
    const activeProcessNames = [...observation.activeIds].sort()
    const providerId = observation.provider?.id ?? null
    const key = `${providerId ?? ''}|${observation.detector}|${activeProcessNames.join(',')}`
    if (key === this.lastProviderObservationLogKey) return
    const previousProviderId = this.lastProviderObservationId
    const isFirst = this.lastProviderObservationLogKey === null
    this.lastProviderObservationLogKey = key
    this.lastProviderObservationId = providerId
    let message: string
    if (providerId && !previousProviderId) message = 'Meeting provider signal appeared'
    else if (!providerId && previousProviderId) message = 'Meeting provider signal disappeared'
    else if (providerId) message = 'Meeting provider signal changed'
    else if (isFirst) message = 'No meeting provider signal'
    else message = 'Capture processes changed without a meeting provider'
    logAutodocEvent({
      area: 'detection',
      message,
      context: {
        providerId,
        previousProviderId,
        detector: observation.detector,
        activeProcessNames
      }
    })
  }

  private logCalendarCandidates(
    events: CalendarEvent[],
    now: number,
    chosen: CalendarEvent | null
  ): void {
    const inProgress = events.filter((event) => event.startTime <= now && event.endTime >= now)
    const candidates = inProgress.map((event) => ({
      eventId: event.id,
      recurringEventId: event.recurringEventId ?? null,
      isAllDay: event.isAllDay === true,
      autoRecordEnabled: isAutoRecordEnabled(event.id, event.recurringEventId),
      hasMeetingUrl: Boolean(event.meetingUrl),
      meetingUrlProvider: inferProviderFromMeetingUrl(event.meetingUrl),
      startTime: event.startTime,
      endTime: event.endTime
    }))
    const timed = candidates.filter((candidate) => !candidate.isAllDay)
    let chosenRule: string
    if (!chosen) {
      chosenRule = candidates.length === 0 ? 'no_in_progress_event' : 'only_all_day_events'
    } else if (timed.length === 1) {
      chosenRule = 'only_timed_candidate'
    } else if (
      timed.some((candidate) => candidate.autoRecordEnabled !== timed[0].autoRecordEnabled) &&
      timed.find((candidate) => candidate.eventId === chosen.id)?.autoRecordEnabled
    ) {
      chosenRule = 'auto_record_enabled_preferred'
    } else {
      chosenRule = 'latest_start_time'
    }
    const chosenEventId = chosen?.id ?? null
    const key = JSON.stringify({ candidates, chosenEventId })
    if (key === this.lastCalendarCandidatesLogKey) return
    this.lastCalendarCandidatesLogKey = key
    logAutodocEvent({
      area: 'detection',
      message: 'Calendar candidates changed',
      context: {
        calendarEventCount: events.length,
        candidateCount: candidates.length,
        candidates,
        chosenEventId,
        chosenRule
      }
    })
  }

  private logDecision(
    decision: DetectionDecision,
    reason: string,
    context: Record<string, unknown> = {}
  ): void {
    const key = JSON.stringify({ decision, reason, ...context })
    if (key === this.lastDecisionLogKey) return
    this.lastDecisionLogKey = key
    logAutodocEvent({
      area: 'detection',
      message: 'Meeting detection decision',
      context: { decision, reason, ...context }
    })
  }

  showSourceSelectionPrompt(requestId: number): void {
    const request = this.pendingAutoRecord
    if (!request || request.payload.requestId !== requestId || this.sourceSelectionPending) return
    if (this.recordingService.getState().isRecording) return
    this.sourceSelectionPending = true
    logAutodocEvent({
      area: 'detection',
      message: 'Meeting window selection required',
      context: { ...request.payload, mainWindowFocused: isMainWindowForegrounded() }
    })
    const openPicker = (): void => {
      if (this.pendingAutoRecord !== request) return
      this.sourceSelectionPending = false
      this.markAutoRecordPending()
      focusMainWindow()
      logAutodocEvent({
        area: 'detection',
        message: 'Meeting window picker opened',
        context: { ...request.payload }
      })
      this.broadcast('detection:select-window', { ...request.payload })
    }
    if (isMainWindowForegrounded()) {
      openPicker()
      return
    }
    this.showBanner(
      'select_window',
      {
        requestId,
        eventId: request.payload.eventId,
        providerId: request.payload.providerId
      },
      {
        title: request.title,
        body: 'Choose a window.',
        primaryActionLabel: 'Select window',
        kind: 'meeting-detection',
        autoDismissMs: 0,
        suppressAppActivationWhileVisible: true,
        onPrimaryAction: openPicker,
        onDismiss: () => this.clearAutoRecordPending()
      }
    )
  }

  async debugPollNow(advanceMs = 0): Promise<void> {
    this.debugNowOffsetMs += advanceMs
    await this.poll()
  }

  private async poll(): Promise<void> {
    try {
      if (this.recordingService.getState().isRecording) {
        this.wasRecording = true
        this.clearAutoRecordPending()
        this.logDecision('skip', 'recording_in_progress')
        if (!this.shouldUseMeetingAutoStop()) {
          this.resetAutoStopState()
          this.hideBanner('meeting-detection', 'recording_started')
          return
        }
        const windowClosed = await this.isRecordedWindowClosed()
        const providerObservation = await this.getActiveProvider()
        const providerDetected = providerObservation.provider !== null
        const meetingWindowObservation =
          await this.getMeetingWindowVisibleForAutoStop(providerDetected)
        const meetingWindowVisible = meetingWindowObservation.visible
        const micActive = process.platform === 'darwin' ? await this.isMicInUseMac() : null

        this.updateAutoStopCounters({
          windowClosed,
          providerDetected,
          meetingWindowVisible,
          micActive
        })

        const snapshot = this.getAutoStopSnapshot(providerDetected, meetingWindowObservation)
        this.recognizeAutoStopEdgeCases(snapshot)
        const reason = this.getAutoStopReason(snapshot)
        this.logAutoStopSignalSnapshot(snapshot, reason, {
          windowClosed,
          providerId: providerObservation.provider?.id ?? null,
          providerName: providerObservation.provider?.name ?? null,
          providerDetector: providerObservation.detector,
          providerActiveIds: providerObservation.activeIds,
          micActive,
          ...(meetingWindowObservation.diagnostics ?? {})
        })
        if (reason) {
          this.maybeBroadcastAutoStop(reason, snapshot)
        } else {
          this.cancelPendingAutoStop(snapshot)
        }

        this.hideBanner('meeting-detection', 'recording_started')
        return
      }

      this.resetAutoStopState()
      this.hideRecordingStartedNotice()
      // Recording ended before the renderer reported its start, so there is nothing to announce.
      if (this.wasRecording) this.unconfirmedAutoRecord = null

      if (this.sourceSelectionPending) {
        const observation = await this.getActiveProvider()
        this.logProviderObservation(observation)
        const signalKey = observation.provider ? `${observation.provider.id}:mic` : ''
        if (signalKey !== this.lastProviderSignalKey) {
          this.clearAutoRecordPending()
          this.hideBanner('meeting-detection', 'provider_signal_changed')
          this.resetProviderState()
        } else {
          this.logDecision('skip', 'source_selection_pending', {
            requestId: this.pendingAutoRecord?.payload.requestId ?? null
          })
          return
        }
      }

      if (this.isAutoRecordPending()) {
        this.logDecision('skip', 'auto_record_pending', {
          requestId: this.pendingAutoRecord?.payload.requestId ?? null
        })
        this.hideBanner('meeting-detection', 'auto_record_pending')
        return
      }

      const matchingEvent = this.findInProgressEvent()
      const providerObservation = await this.getActiveProvider()
      this.logProviderObservation(providerObservation)
      const providerSignalKey = providerObservation.provider
        ? `${providerObservation.provider.id}:mic`
        : ''
      if (this.wasRecording) {
        this.suppressCurrentMeetingSignal(providerSignalKey, matchingEvent?.id ?? null)
        this.wasRecording = false
      }
      if (matchingEvent) {
        await this.handleCalendarEvent(matchingEvent, providerSignalKey)
        return
      }

      const upcomingEvent = this.findUpcomingEventSoon()
      if (upcomingEvent) {
        this.logDecision('skip', 'upcoming_event_within_10_min', {
          upcomingEventId: upcomingEvent.id,
          providerId: providerObservation.provider?.id ?? null
        })
        this.promptedCalendarEventId = null
        this.resetProviderState()
        this.hideBanner('meeting-detection', 'upcoming_event_within_10_min')
        return
      }

      this.promptedCalendarEventId = null
      await this.handleAdHocDetection(providerObservation.provider, providerSignalKey)
    } catch (err) {
      logAutodocFailure({
        area: 'detection',
        message: 'Meeting detection poll failed',
        error: err,
        context: {
          isRecording: this.recordingService.getState().isRecording,
          providerSignalKey: this.lastProviderSignalKey || null
        }
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
    this.loggedStrongMeetingProviderGuardBlock = false
    this.loggedStrongMeetingMicIdleGuardBlock = false
    this.lastAutoStopSignalLogKey = ''
  }

  private shouldUseMeetingAutoStop(): boolean {
    return (this.recordingService.getState().recordingIntent ?? 'meeting') === 'meeting'
  }

  private updateAutoStopCounters(params: {
    windowClosed: boolean
    providerDetected: boolean
    meetingWindowVisible: boolean
    micActive: boolean | null
  }): void {
    this.windowMissingPolls = params.windowClosed ? this.windowMissingPolls + 1 : 0
    this.providerMissingPolls = params.providerDetected ? 0 : this.providerMissingPolls + 1
    this.meetingWindowMissingPolls = params.meetingWindowVisible
      ? 0
      : this.meetingWindowMissingPolls + 1

    if (params.micActive === null) {
      this.micSilentPolls = 0
    } else {
      this.micSilentPolls = params.micActive ? 0 : this.micSilentPolls + 1
    }
  }

  private getAutoStopSnapshot(
    providerDetected: boolean,
    meetingWindowObservation: MeetingWindowObservation
  ): AutoStopSnapshot {
    return {
      sourceType: this.getRecordedSourceType(),
      providerDetected,
      meetingWindowVisible: meetingWindowObservation.visible,
      strongMeetingWindowVisible: meetingWindowObservation.strongVisible,
      windowMissingPolls: this.windowMissingPolls,
      providerMissingPolls: this.providerMissingPolls,
      micSilentPolls: this.micSilentPolls
    }
  }

  private getAutoStopReason(snapshot: AutoStopSnapshot): AutoStopReason | null {
    const micIdleStrong = this.micSilentPolls * POLL_INTERVAL_MS >= AUTO_STOP_GRACE_MS
    const meetingWindowGoneStrong =
      this.meetingWindowMissingPolls >= MEETING_WINDOW_MISSING_POLLS_THRESHOLD
    const providerGoneStrong = this.providerMissingPolls >= PROVIDER_MISSING_POLLS_THRESHOLD
    const windowGoneStrong =
      snapshot.sourceType === 'window' && this.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD
    const browserLikeSource = this.isBrowserLikeSource()
    const blockWeakMacStop =
      process.platform === 'darwin' &&
      snapshot.strongMeetingWindowVisible &&
      snapshot.windowMissingPolls === 0
    const allowWindowClosedStop =
      process.platform !== 'win32' || !snapshot.providerDetected || browserLikeSource

    if (allowWindowClosedStop && windowGoneStrong && meetingWindowGoneStrong) {
      return 'window_closed'
    }

    if (blockWeakMacStop) {
      return null
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
    const providerGoneStrong = snapshot.providerMissingPolls >= PROVIDER_MISSING_POLLS_THRESHOLD

    if (
      !this.loggedFocusSwitchSuppression &&
      snapshot.sourceType === 'window' &&
      snapshot.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD &&
      snapshot.meetingWindowVisible
    ) {
      this.loggedFocusSwitchSuppression = true
      logAutodocEvent({
        area: 'detection',
        message:
          'Auto-stop suppressed — possible focus or desktop switch while meeting remains visible',
        meetingId,
        context: { ...snapshot }
      })
    }

    if (
      !this.loggedStrongMeetingProviderGuardBlock &&
      process.platform === 'darwin' &&
      snapshot.strongMeetingWindowVisible &&
      snapshot.windowMissingPolls === 0 &&
      providerGoneStrong
    ) {
      this.loggedStrongMeetingProviderGuardBlock = true
      logAutodocEvent({
        area: 'detection',
        message:
          'Auto-stop blocked — tracked meeting window still looks active on macOS despite missing provider signals',
        meetingId,
        context: { ...snapshot }
      })
    }

    if (
      !this.loggedStrongMeetingMicIdleGuardBlock &&
      process.platform === 'darwin' &&
      snapshot.strongMeetingWindowVisible &&
      snapshot.windowMissingPolls === 0 &&
      micIdleStrong
    ) {
      this.loggedStrongMeetingMicIdleGuardBlock = true
      logAutodocEvent({
        area: 'detection',
        message:
          'Auto-stop blocked — tracked meeting window still looks active on macOS despite idle mic/provider signals',
        meetingId,
        context: { ...snapshot }
      })
    }

    if (
      !this.loggedLingeringWindowBlock &&
      snapshot.sourceType === 'window' &&
      !snapshot.strongMeetingWindowVisible &&
      !snapshot.providerDetected &&
      snapshot.providerMissingPolls >= PROVIDER_MISSING_POLLS_THRESHOLD &&
      snapshot.meetingWindowVisible &&
      snapshot.windowMissingPolls === 0
    ) {
      this.loggedLingeringWindowBlock = true
      logAutodocEvent({
        area: 'detection',
        message: micIdleStrong
          ? 'Auto-stop blocked — meeting may be over, but the meeting window is still visible'
          : 'Auto-stop blocked — meeting provider disappeared, but the meeting window is still visible',
        meetingId,
        context: { ...snapshot }
      })
    }
  }

  private maybeBroadcastAutoStop(reason: AutoStopReason, snapshot: AutoStopSnapshot): void {
    if (!this.recordingService.getState().isRecording) return

    if (!this.pendingAutoStop || this.pendingAutoStop.reason !== reason) {
      this.pendingAutoStop = {
        reason,
        startedAt: this.getNow()
      }
      return
    }

    if (
      this.getNow() - this.pendingAutoStop.startedAt <
      this.getAutoStopConfirmMs(reason, snapshot)
    ) {
      return
    }

    this.pendingAutoStop = null
    logAutodocEvent({
      area: 'detection',
      message: 'Auto-stop confirmed after sustained missing meeting signals',
      meetingId: this.recordingService.getState().meetingId ?? undefined,
      context: {
        reason,
        ...snapshot
      }
    })
    this.broadcast('detection:auto-stop', {
      reason,
      ...snapshot
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
        recoveredSignals
      }
    })
    this.broadcast('detection:auto-stop-cancelled', {
      reason: pending.reason,
      ...snapshot,
      recoveredSignals
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

    if (
      reason === 'provider_gone' &&
      snapshot.windowMissingPolls >= WINDOW_MISSING_POLLS_THRESHOLD
    ) {
      return 0
    }

    return AUTO_STOP_CONFIRM_MS
  }

  private async getMeetingWindowVisibleForAutoStop(
    providerDetected: boolean
  ): Promise<MeetingWindowObservation> {
    const trackedMeetingObservation = await this.isTrackedMeetingWindowVisible(providerDetected)
    if (trackedMeetingObservation !== null) {
      return trackedMeetingObservation
    }

    return this.isMeetingWindowOpen()
  }

  private async isTrackedMeetingWindowVisible(
    providerDetected: boolean
  ): Promise<MeetingWindowObservation | null> {
    const state = this.recordingService.getState()
    const trackedSourceId = state.trackedMeetingSourceId ?? null
    const trackedSourceName = state.trackedMeetingSourceName ?? null
    const trackedProviderId = state.trackedMeetingProviderId ?? null

    if (!trackedSourceId && !trackedSourceName) {
      return null
    }

    try {
      const sources = await this.getWindowSourcesForDetection()
      const relevantWindowNames = this.getRelevantSourceNames(sources)

      if (trackedSourceId) {
        const trackedSource = sources.find((source) => source.id === trackedSourceId)
        if (trackedSource) {
          if (
            !providerDetected &&
            !hasTrackedMeetingTitleContinuity(
              trackedSource.name,
              trackedSourceName,
              trackedProviderId
            )
          ) {
            return {
              visible: false,
              strongVisible: false,
              diagnostics: {
                trackedSourceId,
                trackedSourceName,
                trackedProviderId,
                matchedTrackedSourceId: trackedSource.id,
                matchedTrackedSourceName: trackedSource.name,
                trackedWindowMatchedBy: 'id',
                trackedWindowTitleContinuity: false,
                totalWindowCount: sources.length,
                relevantWindowNames
              }
            }
          }

          return {
            visible: true,
            strongVisible: true,
            diagnostics: {
              trackedSourceId,
              trackedSourceName,
              trackedProviderId,
              matchedTrackedSourceId: trackedSource.id,
              matchedTrackedSourceName: trackedSource.name,
              trackedWindowMatchedBy: 'id',
              trackedWindowTitleContinuity: true,
              totalWindowCount: sources.length,
              relevantWindowNames
            }
          }
        }
      }

      if (trackedSourceName) {
        const normalizedTrackedName = normalize(trackedSourceName)
        const trackedSource = sources.find(
          (source) => normalize(source.name) === normalizedTrackedName
        )
        return {
          visible: Boolean(trackedSource),
          strongVisible: Boolean(trackedSource),
          diagnostics: {
            trackedSourceId,
            trackedSourceName,
            trackedProviderId,
            matchedTrackedSourceId: trackedSource?.id ?? null,
            matchedTrackedSourceName: trackedSource?.name ?? null,
            trackedWindowMatchedBy: trackedSource ? 'name' : 'none',
            trackedWindowTitleContinuity: trackedSource ? true : null,
            totalWindowCount: sources.length,
            relevantWindowNames
          }
        }
      }

      return {
        visible: false,
        strongVisible: false,
        diagnostics: {
          trackedSourceId,
          trackedSourceName,
          trackedProviderId,
          matchedTrackedSourceId: null,
          matchedTrackedSourceName: null,
          trackedWindowMatchedBy: 'none',
          trackedWindowTitleContinuity: null,
          totalWindowCount: sources.length,
          relevantWindowNames
        }
      }
    } catch {
      return null
    }
  }

  private async isMeetingWindowOpen(): Promise<MeetingWindowObservation> {
    try {
      const sources = await this.getWindowSourcesForDetection()
      return {
        visible: sources.some((s) =>
          MEETING_APP_PATTERNS.some(({ pattern }) => pattern.test(s.name))
        ),
        strongVisible: false,
        diagnostics: {
          trackedSourceId: null,
          trackedSourceName: null,
          trackedProviderId: null,
          matchedTrackedSourceId: null,
          matchedTrackedSourceName: null,
          trackedWindowMatchedBy: 'fallback',
          trackedWindowTitleContinuity: null,
          totalWindowCount: sources.length,
          relevantWindowNames: this.getRelevantSourceNames(sources)
        }
      }
    } catch {
      return {
        visible: true,
        strongVisible: false,
        diagnostics: {
          trackedSourceId: null,
          trackedSourceName: null,
          trackedProviderId: null,
          matchedTrackedSourceId: null,
          matchedTrackedSourceName: null,
          trackedWindowMatchedBy: 'fallback-error',
          trackedWindowTitleContinuity: null,
          totalWindowCount: null,
          relevantWindowNames: []
        }
      }
    }
  }

  private getRelevantSourceNames(sources: Array<{ name: string }>): string[] {
    return sources
      .map((source) => source.name)
      .filter((name) => MEETING_APP_PATTERNS.some(({ pattern }) => pattern.test(name)))
      .slice(0, 10)
  }

  private async getWindowSourcesForDetection(): Promise<Array<{ id: string; name: string }>> {
    if (isE2E) {
      return getE2EDetectionState().windowSources
    }

    return await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
  }

  private logAutoStopSignalSnapshot(
    snapshot: AutoStopSnapshot,
    reason: AutoStopReason | null,
    diagnostics: Record<string, unknown>
  ): void {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return

    const key = JSON.stringify({
      platform: process.platform,
      reason,
      ...snapshot,
      trackedWindowMatchedBy: diagnostics.trackedWindowMatchedBy ?? null,
      trackedWindowTitleContinuity: diagnostics.trackedWindowTitleContinuity ?? null,
      matchedTrackedSourceId: diagnostics.matchedTrackedSourceId ?? null,
      matchedTrackedSourceName: diagnostics.matchedTrackedSourceName ?? null,
      providerId: diagnostics.providerId ?? null,
      providerDetector: diagnostics.providerDetector ?? null,
      providerActiveIds: diagnostics.providerActiveIds ?? null,
      micActive: diagnostics.micActive ?? null,
      windowClosed: diagnostics.windowClosed ?? null
    })

    if (key === this.lastAutoStopSignalLogKey) {
      return
    }

    this.lastAutoStopSignalLogKey = key
    logAutodocEvent({
      area: 'detection',
      message:
        process.platform === 'darwin'
          ? 'macOS auto-stop signal snapshot'
          : 'Windows auto-stop signal snapshot',
      meetingId: this.recordingService.getState().meetingId ?? undefined,
      level: reason ? 'warn' : 'info',
      context: {
        reason,
        ...snapshot,
        ...diagnostics
      }
    })
  }

  private async isRecordedWindowClosed(): Promise<boolean> {
    const state = this.recordingService.getState()
    if (!state.sourceId || state.sourceId.startsWith('screen:')) {
      return false
    }

    try {
      const sources = await this.getWindowSourcesForDetection()
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
    return (
      BROWSER_PATTERNS.some((pattern) => pattern.test(sourceName)) ||
      /\b(safari|chrome|firefox|edge|brave|arc|opera|vivaldi)\b/i.test(sourceName)
    )
  }

  private getNow(): number {
    return Date.now() + this.debugNowOffsetMs
  }

  private async handleCalendarEvent(
    event: CalendarEvent,
    providerSignalKey: string
  ): Promise<void> {
    if (!providerSignalKey) {
      this.logDecision('skip', 'no_provider_signal', { eventId: event.id })
      if (this.lastProviderSignalKey) {
        this.broadcast('detection:mic-inactive', {})
        this.lastProviderSignalKey = ''
      }
      this.hideBanner('meeting-detection', 'call_ended')
      return
    }

    const providerId = providerSignalKey.split(':')[0]
    if (this.shouldSuppressPrompt(providerSignalKey, event.id)) {
      this.logDecision('skip', 'suppressed_after_manual_stop', { eventId: event.id, providerId })
      return
    }

    const providerJustActivated = providerSignalKey !== this.lastProviderSignalKey
    this.lastProviderSignalKey = providerSignalKey

    if (!providerJustActivated && this.promptedCalendarEventId === event.id) {
      this.logDecision('skip', 'already_prompted_for_event', { eventId: event.id, providerId })
      return
    }

    this.promptedCalendarEventId = event.id
    this.promptForCalendarEvent(event, providerSignalKey.split(':')[0])
  }

  private async handleAdHocDetection(
    provider: MeetingProvider | null,
    providerSignalKey: string
  ): Promise<void> {
    if (!provider) {
      this.logDecision('skip', 'no_provider_signal')
      this.resetProviderState()
      this.hideBanner('meeting-detection', 'call_ended')
      return
    }

    if (this.shouldSuppressPrompt(providerSignalKey, null)) {
      this.logDecision('skip', 'suppressed_after_manual_stop', { providerId: provider.id })
      this.lastProviderSignalKey = providerSignalKey
      return
    }

    if (providerSignalKey === this.lastProviderSignalKey) {
      this.logDecision('skip', 'already_prompted_for_provider_signal', { providerId: provider.id })
      return
    }

    this.lastProviderSignalKey = providerSignalKey
    this.logDecision('prompt', 'ad_hoc_provider_signal', { providerId: provider.id })
    this.showPrompt(provider.name, provider.id)
  }

  private async getActiveProvider(): Promise<MeetingProviderObservation> {
    if (isE2E) {
      const activeIds = getE2EDetectionState().providerActiveIds
      return {
        provider: matchProviderFromIds(activeIds),
        activeIds,
        detector: process.platform === 'win32' ? 'windows_helper' : 'mac_helper'
      }
    }

    if (process.platform === 'darwin') {
      const activeIds = await getActiveCaptureProcessIdsMac()
      return {
        provider: matchProviderFromIds(activeIds),
        activeIds,
        detector: 'mac_helper'
      }
    }

    if (process.platform === 'win32') {
      const activeIds = await getActiveCaptureProcessIdsWindows()
      return {
        provider: matchProviderFromIds(activeIds),
        activeIds,
        detector: 'windows_helper'
      }
    }

    return {
      provider: null,
      activeIds: [],
      detector: 'unsupported'
    }
  }

  private isMicInUseMac(): Promise<boolean | null> {
    if (isE2E) {
      return Promise.resolve(getE2EDetectionState().micActive)
    }

    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'assertions'], { timeout: 2_000 }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve(stdout.includes('audio-in'))
      })
    })
  }

  private showPrompt(
    title: string,
    providerId: string | null,
    event: CalendarEvent | null = null
  ): void {
    const body = 'Would you like to start AI notes?'

    this.showBanner(
      'start_prompt',
      {
        requestId: null,
        nextRequestId: this.autoRecordRequestId + 1,
        eventId: event?.id ?? null,
        providerId,
        hasCalendarEvent: event !== null
      },
      {
        title,
        body,
        primaryActionLabel: 'Start AI Notes',
        kind: 'meeting-detection',
        suppressAppActivationWhileVisible: true,
        onPrimaryAction: () => {
          focusMainWindow()
          this.requestAutoRecord(title, providerId, event, true)
        },
        onDismiss: () => {}
      }
    )
  }

  private promptForCalendarEvent(event: CalendarEvent, detectedProviderId: string): void {
    const providerId = inferProviderFromMeetingUrl(event.meetingUrl) ?? detectedProviderId
    if (isAutoRecordEnabled(event.id, event.recurringEventId)) {
      this.logDecision('auto_record', 'auto_record_enabled_for_event', {
        eventId: event.id,
        providerId
      })
      this.requestAutoRecord(event.title, providerId, event, false)
      return
    }

    this.logDecision('prompt', 'calendar_event_without_auto_record', {
      eventId: event.id,
      providerId
    })
    this.showPrompt(event.title, providerId, event)
  }

  private requestAutoRecord(
    title: string,
    providerId: string | null,
    event: CalendarEvent | null,
    confirmed: boolean
  ): void {
    const payload: DetectionAutoRecordPayload = {
      requestId: ++this.autoRecordRequestId,
      providerId,
      hasCalendarEvent: event !== null,
      eventId: event?.id ?? null,
      recurringEventId: event?.recurringEventId ?? null
    }
    this.pendingAutoRecord = { title, payload, confirmed }
    this.unconfirmedAutoRecord = confirmed
      ? null
      : {
          requestId: payload.requestId,
          title,
          eventId: payload.eventId,
          providerId: payload.providerId
        }
    this.markAutoRecordPending()
    logAutodocEvent({
      area: 'detection',
      message: 'Auto-record requested',
      context: { ...payload, confirmedByUser: confirmed }
    })
    this.broadcast('detection:auto-record', { ...payload })
  }

  private findInProgressEvent(): CalendarEvent | null {
    const now = this.getNow()
    const events = this.getCalendarEvents()
    const chosen = selectActiveCalendarEvent(events, now, (event) =>
      isAutoRecordEnabled(event.id, event.recurringEventId)
    )
    this.logCalendarCandidates(events, now, chosen)
    return chosen
  }

  private findUpcomingEventSoon(): CalendarEvent | null {
    const now = this.getNow()
    const events = this.getCalendarEvents()

    return (
      events.find(
        (event) =>
          !event.isAllDay && event.startTime > now && event.startTime - now < EVENT_WINDOW_MS
      ) ?? null
    )
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
    this.autoRecordPendingUntil = this.getNow() + AUTO_RECORD_START_GRACE_MS
  }

  private clearAutoRecordPending(): void {
    this.autoRecordPendingUntil = 0
    this.pendingAutoRecord = null
    this.sourceSelectionPending = false
  }

  private isAutoRecordPending(): boolean {
    if (this.autoRecordPendingUntil === 0) return false
    if (this.getNow() < this.autoRecordPendingUntil) return true
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
