import { BROWSER_PATTERNS, MEETING_APP_PATTERNS } from '../../../shared/constants'
import type {
  CalendarEvent,
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

export interface AutoRecordSourceSelection {
  source: RecordingSource | null
  confidence: 'high' | 'low' | 'none'
  method: 'remembered_source' | 'provider_hint' | 'meeting_pattern' | 'browser_window' | 'none'
  providerHint: string | null
  windowCount: number
  browserWindowCount: number
  meetingWindowCount: number
}

interface ScoredSource {
  source: RecordingSource
  score: number
  method: AutoRecordSourceSelection['method']
}

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
      meetingWindowCount: 0
    }
  }

  const browserWindowCount = windows.filter((source) => isBrowserWindowName(source.name)).length
  const meetingWindowCount = windows.filter((source) => isMeetingPatternMatch(source.name)).length

  const scored = windows
    .map((source): ScoredSource => {
      let score = 0
      let method: AutoRecordSourceSelection['method'] = 'none'

      if (preference && matchesPreferredSource(source, preference)) {
        score += 120
        method = 'remembered_source'
      }

      if (providerHint && matchesProviderHint(source.name, providerHint)) {
        score += 90
        if (method === 'none') method = 'provider_hint'
      }

      if (isMeetingPatternMatch(source.name)) {
        score += 70
        if (method === 'none') method = 'meeting_pattern'
      }

      if (isBrowserWindowName(source.name)) {
        score += 20
        if (method === 'none') method = 'browser_window'
      }

      return { source, score, method }
    })
    .sort((left, right) => right.score - left.score)

  const best = scored[0]
  const secondBest = scored[1]
  const scoreGap = secondBest ? best.score - secondBest.score : best.score

  if (!best || best.score <= 0) {
    return {
      source: null,
      confidence: 'none',
      method: 'none',
      providerHint,
      windowCount: windows.length,
      browserWindowCount,
      meetingWindowCount
    }
  }

  const confidence = best.score >= 90 && scoreGap >= 15 ? 'high' : 'low'

  return {
    source: best.source,
    confidence,
    method: best.method === 'none' ? 'meeting_pattern' : best.method,
    providerHint,
    windowCount: windows.length,
    browserWindowCount,
    meetingWindowCount
  }
}

export function findActiveCalendarEvent(
  events: CalendarEvent[],
  now = Date.now()
): CalendarEvent | null {
  for (const event of events) {
    if (event.startTime <= now && event.endTime >= now) {
      return event
    }
  }

  return null
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

export function buildRecordingTrackingContext(
  selectedSource: RecordingSource,
  detectedMeetingSource: RecordingSource | null,
  selectionContext?: RecordingSelectionContext,
  trigger: 'manual' | 'auto_record' = 'manual'
): RecordingTrackingContext {
  const recordingIntent = inferRecordingIntent(selectedSource, detectedMeetingSource, trigger)
  const trackedSource =
    recordingIntent === 'meeting'
      ? (selectedSource.id.startsWith('screen:') ? detectedMeetingSource : selectedSource)
      : null

  return {
    meetingSourceId: trackedSource?.id ?? null,
    meetingSourceName: trackedSource?.name ?? null,
    providerId:
      trackedSource ? selectionContext?.providerHint ?? inferProviderHintFromSourceName(trackedSource.name) : null,
    recordingIntent
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

function matchesPreferredSource(
  source: RecordingSource,
  preference: SavedSourcePreference
): boolean {
  if (source.id === preference.sourceId) return true
  return normalizeWindowName(source.name) === normalizeWindowName(preference.sourceName)
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

  if (normalizeWindowName(selectedSource.name) === normalizeWindowName(detectedMeetingSource.name)) {
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
