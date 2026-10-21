import { BROWSER_PATTERNS, MEETING_APP_PATTERNS } from '../../../shared/constants'
import { selectActiveCalendarEvent } from '../../../shared/calendar-selection'
import type {
  CalendarEvent,
  DetectionAutoRecordPayload,
  RecordingIntent,
  RecordingSource,
  RecordingTrackingContext
} from '../../../shared/types'
import type { SavedSourcePreference } from './recording-source-preferences'

export interface RecordingSelectionContext {
  eventId: string | null
  recurringEventId: string | null
  providerHint: string | null
}

/** Per-window scoring detail for diagnostics. Never carries the window name. */
export interface AutoRecordCandidateDiagnostics {
  sourceType: 'window' | 'screen'
  score: number
  method: AutoRecordSourceSelection['method']
  providerHintMatch: boolean
  meetingPattern: boolean
  browser: boolean
  slackHuddleName: boolean
  slackMainWindowName: boolean
  slackPreviewWindowName: boolean
  rememberedSource: boolean
}

export interface AutoRecordSourceSelection {
  source: RecordingSource | null
  confidence: 'high' | 'low' | 'none'
  method: 'remembered_source' | 'provider_hint' | 'meeting_pattern' | 'browser_window' | 'none'
  providerHint: string | null
  windowCount: number
  browserWindowCount: number
  meetingWindowCount: number
  bestScore: number
  secondBestScore: number | null
  /** Scored windows, best first, limited to the top AUTO_RECORD_DIAGNOSTIC_CANDIDATES. */
  candidates: AutoRecordCandidateDiagnostics[]
  /** Source ids in the same order as `candidates` (ids only, no window names). */
  candidateSourceIds: string[]
  /** Index into `candidates` of the chosen source, or null when nothing was chosen. */
  chosenIndex: number | null
}

interface ScoredSource {
  source: RecordingSource
  score: number
  method: AutoRecordSourceSelection['method']
  features: Omit<AutoRecordCandidateDiagnostics, 'sourceType' | 'score' | 'method'>
}

export const AUTO_RECORD_DIAGNOSTIC_CANDIDATES = 6

const BROWSER_NAME_PATTERNS = [
  /\bsafari\b/i,
  /\bgoogle chrome\b/i,
  /\bchrome\b/i,
  /\bfirefox\b/i,
  /\bmicrosoft edge\b/i,
  /\bedge\b/i,
  /\bbrave\b/i,
  /\barc\b/i,
  /\bopera\b/i,
  /\bvivaldi\b/i
]

const SLACK_MAIN_WINDOW_PENALTY = 60

const GENERIC_PROVIDER_WINDOW_NAMES = new Set([
  'slack',
  'teams',
  'microsoft teams',
  'zoom',
  'zoom workplace',
  'zoom meetings'
])

export function detectMeetingWindow(
  sources: RecordingSource[],
  context?: RecordingSelectionContext,
  preference?: SavedSourcePreference | null
): RecordingSource | null {
  const selection = chooseAutoRecordSource(sources, context, preference)
  return selection.source
}

export function chooseAutoRecordSource(
  sources: RecordingSource[],
  context?: RecordingSelectionContext,
  preference?: SavedSourcePreference | null
): AutoRecordSourceSelection {
  const windows = sources.filter((source) => !source.id.startsWith('screen:'))
  const providerHint = context?.providerHint ?? null

  if (windows.length === 0) {
    return {
      source: null,
      confidence: 'none',
      method: 'none',
      providerHint,
      windowCount: 0,
      browserWindowCount: 0,
      meetingWindowCount: 0,
      bestScore: 0,
      secondBestScore: null,
      candidates: [],
      candidateSourceIds: [],
      chosenIndex: null
    }
  }

  const browserWindowCount = windows.filter((source) => isBrowserWindowName(source.name)).length
  const meetingWindowCount = windows.filter((source) => isMeetingPatternMatch(source.name)).length

  const scored = windows
    .map((source): ScoredSource => {
      let score = 0
      let method: AutoRecordSourceSelection['method'] = 'none'
      const features: ScoredSource['features'] = {
        providerHintMatch: false,
        meetingPattern: false,
        browser: false,
        slackHuddleName: false,
        slackMainWindowName: false,
        slackPreviewWindowName: false,
        rememberedSource: false
      }

      const slackKind = getSlackWindowKind(source.name)
      const slackNonMeeting = slackKind === 'main' || slackKind === 'preview'

      // A remembered choice must never lift a Slack main or pre-join window: an earlier wrong
      // automatic pick can otherwise outrank the real huddle window.
      const preferenceMatch =
        preference && !slackNonMeeting ? getPreferredSourceMatch(source, preference) : null
      if (preferenceMatch) {
        score += preferenceMatch === 'id' ? 150 : 120
        features.rememberedSource = true
        method = 'remembered_source'
      }

      if (slackKind === 'huddle') {
        score += 110
        features.slackHuddleName = true
        if (method === 'none') method = 'meeting_pattern'
      }

      if (providerHint && matchesProviderHint(source.name, providerHint)) {
        score += 90
        features.providerHintMatch = true
        if (method === 'none') method = 'provider_hint'
      }

      if (isMeetingPatternMatch(source.name)) {
        score += 70
        features.meetingPattern = true
        if (method === 'none') method = 'meeting_pattern'
      }

      // The main Slack window (a DM or channel view) and the pre-join preview match the same
      // patterns as the huddle window; demote them so a huddle window beats them instead of tying.
      if (slackKind === 'main') {
        score -= SLACK_MAIN_WINDOW_PENALTY
        features.slackMainWindowName = true
      } else if (slackKind === 'preview') {
        score -= SLACK_MAIN_WINDOW_PENALTY
        features.slackPreviewWindowName = true
      }

      if (isBrowserWindowName(source.name)) {
        score += 20
        features.browser = true
        if (method === 'none') method = 'browser_window'
      }

      return { source, score, method, features }
    })
    .sort((left, right) => right.score - left.score)

  const best = scored[0]
  const secondBest = scored[1]
  const candidates = scored.slice(0, AUTO_RECORD_DIAGNOSTIC_CANDIDATES).map(
    (entry): AutoRecordCandidateDiagnostics => ({
      sourceType: 'window',
      score: entry.score,
      method: entry.method,
      ...entry.features
    })
  )
  const candidateSourceIds = scored
    .slice(0, AUTO_RECORD_DIAGNOSTIC_CANDIDATES)
    .map((entry) => entry.source.id)
  const scoreGap = secondBest ? best.score - secondBest.score : best.score

  if (!best || best.score <= 0) {
    return {
      source: null,
      confidence: 'none',
      method: 'none',
      providerHint,
      windowCount: windows.length,
      browserWindowCount,
      meetingWindowCount,
      bestScore: best?.score ?? 0,
      secondBestScore: secondBest?.score ?? null,
      candidates,
      candidateSourceIds,
      chosenIndex: null
    }
  }

  if (secondBest && best.score === secondBest.score) {
    return {
      source: null,
      confidence: 'none',
      method: 'none',
      providerHint,
      windowCount: windows.length,
      browserWindowCount,
      meetingWindowCount,
      bestScore: best?.score ?? 0,
      secondBestScore: secondBest?.score ?? null,
      candidates,
      candidateSourceIds,
      chosenIndex: null
    }
  }

  // Slack turns the mic on in its pre-join preview, before the huddle window exists, and the main
  // window outlives the huddle. Neither may ever be recorded without the user choosing it.
  const bestIsSlackNonMeeting =
    best.features.slackMainWindowName || best.features.slackPreviewWindowName
  const confidence = best.score >= 90 && scoreGap >= 15 && !bestIsSlackNonMeeting ? 'high' : 'low'

  return {
    source: best.source,
    confidence,
    method: best.method === 'none' ? 'meeting_pattern' : best.method,
    providerHint,
    windowCount: windows.length,
    browserWindowCount,
    meetingWindowCount,
    bestScore: best.score,
    secondBestScore: secondBest?.score ?? null,
    candidates,
    candidateSourceIds,
    chosenIndex: 0
  }
}

export function findActiveCalendarEvent(
  events: CalendarEvent[],
  now = Date.now()
): CalendarEvent | null {
  return selectActiveCalendarEvent(events, now)
}

export function buildRecordingSelectionContext(
  event: CalendarEvent | null,
  fallbackProviderId: string | null = null
): RecordingSelectionContext {
  return {
    eventId: event?.id ?? null,
    recurringEventId: event?.recurringEventId ?? null,
    providerHint: inferProviderHint(event?.meetingUrl) ?? fallbackProviderId
  }
}

export function buildAutoRecordSelectionContext(
  payload: DetectionAutoRecordPayload
): RecordingSelectionContext {
  return {
    eventId: payload.eventId,
    recurringEventId: payload.recurringEventId,
    providerHint: payload.providerId
  }
}

export function buildRecordingTrackingContext(
  selectedSource: RecordingSource,
  detectedMeetingSource: RecordingSource | null,
  selectionContext?: RecordingSelectionContext,
  trigger: 'manual' | 'auto_record' = 'manual'
): RecordingTrackingContext {
  const recordingIntent = inferRecordingIntent(selectedSource, detectedMeetingSource, trigger)
  const trackedSource =
    recordingIntent === 'meeting'
      ? selectedSource.id.startsWith('screen:')
        ? detectedMeetingSource
        : selectedSource
      : null

  return {
    meetingSourceId: trackedSource?.id ?? null,
    meetingSourceName: trackedSource?.name ?? null,
    providerId: trackedSource
      ? (selectionContext?.providerHint ?? inferProviderHintFromSourceName(trackedSource.name))
      : null,
    recordingIntent,
    selectionEventId: selectionContext?.eventId ?? null
  }
}

export function inferProviderHint(meetingUrl: string | null | undefined): string | null {
  if (!meetingUrl) return null

  if (/zoom\.us/i.test(meetingUrl)) return 'zoom'
  if (/teams\.microsoft\.com/i.test(meetingUrl)) return 'teams'
  if (/meet\.google\.com/i.test(meetingUrl)) return 'google_meet'
  if (/webex\.com/i.test(meetingUrl)) return 'webex'
  if (/slack\.com/i.test(meetingUrl)) return 'slack'

  return null
}

function getPreferredSourceMatch(
  source: RecordingSource,
  preference: SavedSourcePreference
): 'id' | 'name' | null {
  if (source.id === preference.sourceId) return 'id'
  const normalizedSourceName = normalizeWindowName(source.name)
  if (GENERIC_PROVIDER_WINDOW_NAMES.has(normalizedSourceName)) return null
  return normalizedSourceName === normalizeWindowName(preference.sourceName) ? 'name' : null
}

function isSlackHuddleWindowName(name: string): boolean {
  const normalizedName = normalizeWindowName(name)
  return normalizedName.includes('slack') && /\bhuddle\b/.test(normalizedName)
}

type SlackWindowKind = 'huddle' | 'main' | 'preview' | 'other'

// Slack's sidebar views; the main window takes the view's name as its first title segment.
const SLACK_MAIN_VIEW_NAMES = new Set([
  'home',
  'dms',
  'activity',
  'later',
  'huddles',
  'threads',
  'files',
  'search',
  'drafts & sent',
  'canvases',
  'lists',
  'directories',
  'templates',
  'workflows',
  'more',
  'agents',
  'mentions & reactions',
  'saved items',
  'people',
  'channels'
])

// Slack titles its main window "<view> (DM|Channel|...) - <workspace> - Slack", sometimes with a
// "[Main]" marker appended, or "<sidebar view> - <workspace> - Slack" (for example "Huddles" or
// "Activity"). The pre-join preview has an empty first segment ("- <workspace> - ... - Slack").
// Huddle windows have no parenthesised view marker in their first segment.
function getSlackWindowKind(name: string): SlackWindowKind {
  const normalizedName = normalizeWindowName(name)
  if (!normalizedName.includes('slack')) return 'other'
  if (normalizedName.includes('[main]')) return 'main'
  if (isSlackHuddleWindowName(name)) return 'huddle'
  if (normalizedName === '-' || normalizedName.startsWith('- ')) return 'preview'
  const firstSegment = normalizedName.split(' - ')[0].trim()
  if (SLACK_MAIN_VIEW_NAMES.has(firstSegment) || /\([^)]+\)$/.test(firstSegment)) return 'main'
  return 'other'
}

function isMeetingPatternMatch(name: string): boolean {
  return MEETING_APP_PATTERNS.some(({ pattern }) => pattern.test(name))
}

function inferRecordingIntent(
  selectedSource: RecordingSource,
  detectedMeetingSource: RecordingSource | null,
  trigger: 'manual' | 'auto_record'
): RecordingIntent {
  if (trigger === 'auto_record') {
    return 'meeting'
  }

  if (isMeetingPatternMatch(selectedSource.name)) {
    return 'meeting'
  }

  if (!detectedMeetingSource) {
    return 'general'
  }

  if (selectedSource.id.startsWith('screen:')) {
    return 'meeting'
  }

  if (selectedSource.id === detectedMeetingSource.id) {
    return 'meeting'
  }

  if (
    normalizeWindowName(selectedSource.name) === normalizeWindowName(detectedMeetingSource.name)
  ) {
    return 'meeting'
  }

  return 'general'
}

function isBrowserWindowName(name: string): boolean {
  return (
    BROWSER_PATTERNS.some((pattern) => pattern.test(name)) ||
    BROWSER_NAME_PATTERNS.some((pattern) => pattern.test(name))
  )
}

function matchesProviderHint(name: string, providerHint: string): boolean {
  const normalizedName = normalizeWindowName(name)

  switch (providerHint) {
    case 'zoom':
      return normalizedName.includes('zoom')
    case 'teams':
      return normalizedName.includes('teams')
    case 'google_meet':
      return (
        normalizedName.includes('google meet') ||
        normalizedName.includes('meet.google.com') ||
        normalizedName.includes('meet ')
      )
    case 'webex':
      return normalizedName.includes('webex')
    case 'slack':
      return normalizedName.includes('slack')
    case 'discord':
      return normalizedName.includes('discord')
    default:
      return false
  }
}

function inferProviderHintFromSourceName(name: string): string | null {
  if (matchesProviderHint(name, 'zoom')) return 'zoom'
  if (matchesProviderHint(name, 'teams')) return 'teams'
  if (matchesProviderHint(name, 'google_meet')) return 'google_meet'
  if (matchesProviderHint(name, 'webex')) return 'webex'
  if (matchesProviderHint(name, 'slack')) return 'slack'
  if (matchesProviderHint(name, 'discord')) return 'discord'

  return null
}

function normalizeWindowName(name: string): string {
  return name.trim().toLowerCase()
}
