import posthog from 'posthog-js'
import type { AnalyticsLocalSignal, AnalyticsState, AppRuntimeInfo } from '../../../shared/types'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com'

let initialized = false
let consentGiven = false
let identifiedInstallId: string | null = null
let analyticsContext: Record<string, string | boolean | undefined> = {
  platform: 'desktop',
  build_mode: import.meta.env.MODE,
  build_channel: import.meta.env.DEV ? 'development' : 'custom'
}

const SENSITIVE_KEY_PATTERNS = [
  /meeting_?id/i,
  /meeting_?title/i,
  /calendar_?title/i,
  /calendar_?event/i,
  /participant/i,
  /attendee/i,
  /email/i,
  /file/i,
  /path/i,
  /folder/i,
  /source_?name/i,
  /device_?name/i,
  /(^|_)transcript($|_)/i,
  /summary_text/i,
  /prompt/i,
  /raw/i,
  /log/i,
  /audio/i,
  /video/i
]

const PROPERTY_ALIASES: Record<string, string> = {
  errorCode: 'failure_code',
  failedStep: 'failure_code',
  duration_seconds: 'duration_bucket',
  result_count: 'result_count_bucket'
}

const ALLOWED_PROPERTIES = new Set([
  'activation_reason',
  'app_arch',
  'app_platform',
  'app_version',
  'attempt_number',
  'available_version',
  'backend',
  'browser_window_count',
  'build_channel',
  'build_mode',
  'clarification_options_count',
  'component',
  'consented',
  'current_version',
  'days_since_first_launch',
  'duration_bucket',
  'export_format',
  'failure_code',
  'feature_name',
  'first_notes_generated',
  'first_recording_completed',
  'has_calendar_event',
  'has_suggestion',
  'is_first_use',
  'meeting_window_count',
  'model',
  'notes_generated_bucket',
  'official_build',
  'ollama_model',
  'onboarding_completed',
  'onboarding_started',
  'permission_type',
  'phase',
  'platform',
  'previous_version',
  'processing_time_bucket',
  'provider',
  'provider_detected',
  'provider_hint',
  'reason',
  'reason_code',
  'recordings_completed_bucket',
  'result_count_bucket',
  'selected_recording',
  'selection_confidence',
  'selection_method',
  'session_duration_bucket',
  'session_id',
  'setting_name',
  'setting_value_bucket',
  'setup_completed',
  'source_selection_mode',
  'source_type',
  'step',
  'transcription_backend',
  'trigger',
  'user_activated',
  'whisper_model',
  'window_count'
])

function hasElectronApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI)
}

function bucketDurationSeconds(seconds: number): string {
  if (seconds < 10) return '0-9s'
  if (seconds < 60) return '10-59s'
  if (seconds < 5 * 60) return '1-4m'
  if (seconds < 30 * 60) return '5-29m'
  if (seconds < 60 * 60) return '30-59m'
  if (seconds < 2 * 60 * 60) return '1-2h'
  return '2h+'
}

function bucketCount(count: number): string {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count <= 3) return '2-3'
  if (count <= 10) return '4-10'
  if (count <= 25) return '11-25'
  return '26+'
}

export function toDurationBucket(seconds: number): string {
  return bucketDurationSeconds(Math.max(0, Math.floor(seconds)))
}

export function toCountBucket(count: number): string {
  return bucketCount(Math.max(0, Math.floor(count)))
}

function normalizePropertyValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (key === 'duration_bucket' && typeof value === 'number') {
    return bucketDurationSeconds(value)
  }
  if (key === 'result_count_bucket' && typeof value === 'number') {
    return bucketCount(value)
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return undefined
}

export function sanitizeAnalyticsProperties(
  properties?: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}

  for (const [rawKey, rawValue] of Object.entries(properties ?? {})) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(rawKey))) continue

    const key = PROPERTY_ALIASES[rawKey] ?? rawKey
    if (!ALLOWED_PROPERTIES.has(key)) continue

    const value = normalizePropertyValue(key, rawValue)
    if (value !== undefined) {
      sanitized[key] = value
    }
  }

  return sanitized
}

function buildEventProperties(properties?: Record<string, unknown>): Record<string, unknown> {
  return sanitizeAnalyticsProperties({
    ...analyticsContext,
    ...properties
  })
}

export function setAnalyticsContext(runtimeInfo: AppRuntimeInfo): void {
  analyticsContext = {
    platform: 'desktop',
    app_version: runtimeInfo.appVersion,
    app_platform: runtimeInfo.platform,
    app_arch: runtimeInfo.arch,
    official_build: runtimeInfo.officialBuild,
    build_channel: runtimeInfo.buildChannel,
    build_mode: import.meta.env.MODE,
    transcription_backend: runtimeInfo.transcriptionBackend,
    whisper_model: runtimeInfo.whisperModel,
    ollama_model: runtimeInfo.ollamaModel
  }
}

/**
 * Initialize PostHog — called once at app start.
 * Does NOT send events until consent is granted via `setAnalyticsConsent(true)`.
 */
export function initAnalytics(): void {
  if (!POSTHOG_KEY || initialized) return
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    persistence: 'localStorage',
    request_batching: false,
    opt_out_capturing_by_default: true,
    // AutoDoc is a desktop app, and Electron E2E runs expose navigator.webdriver.
    opt_out_useragent_filter: true
  })
  initialized = true
}

/**
 * Identify the anonymous install. This must only be called after consent exists.
 */
export function identifyDevice(deviceId: string): void {
  if (!initialized || identifiedInstallId === deviceId) return
  posthog.identify(deviceId)
  identifiedInstallId = deviceId
}

export async function getAnalyticsState(): Promise<AnalyticsState | null> {
  if (!hasElectronApi()) return null
  return await window.electronAPI.invoke('analytics:get-state').catch(() => null)
}

export async function getDaysSinceFirstLaunch(): Promise<number | undefined> {
  const state = await getAnalyticsState()
  if (!state) return undefined
  const startedAt = new Date(state.firstLaunchDate).getTime()
  if (!Number.isFinite(startedAt)) return 0
  return Math.max(0, Math.floor((Date.now() - startedAt) / 86_400_000))
}

export async function identifyConsentedInstall(): Promise<AnalyticsState | null> {
  const state = await getAnalyticsState()
  if (state) {
    identifyDevice(state.installId)
  }
  return state
}

/**
 * Call when the user makes their analytics choice.
 * Declines must not emit analytics. Opt-ins record the consent event after enabling capture.
 */
export function setAnalyticsConsent(enabled: boolean): void {
  if (!initialized) return

  if (enabled) {
    consentGiven = true
    posthog.opt_in_capturing({ captureEventName: false })
    posthog.capture('analytics_consent', buildEventProperties({ consented: true }), {
      send_instantly: true
    })
  } else {
    consentGiven = false
    posthog.opt_out_capturing()
  }
}

/**
 * Restore consent state from persisted preference (called on app load for returning users).
 */
export function restoreAnalyticsConsent(enabled: boolean): void {
  if (!initialized) return
  consentGiven = enabled
  if (enabled) {
    posthog.opt_in_capturing({ captureEventName: false })
  } else {
    posthog.opt_out_capturing()
  }
}

/**
 * Track an event — silently no-ops if user hasn't consented or PostHog isn't initialized.
 */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!initialized || !consentGiven) return
  posthog.capture(event, buildEventProperties(properties))
}

export async function recordAnalyticsLocalSignal(signal: AnalyticsLocalSignal): Promise<boolean> {
  if (!hasElectronApi()) return false
  return await window.electronAPI.invoke('analytics:record-local-signal', signal).catch(() => false)
}

export async function trackFirstEventOnce(
  signal: AnalyticsLocalSignal,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  const firstOccurrence = await recordAnalyticsLocalSignal(signal)
  if (firstOccurrence) {
    trackEvent(event, properties)
  }
}

export async function trackConsentSnapshot(): Promise<void> {
  if (!hasElectronApi()) return
  const snapshot = await window.electronAPI
    .invoke('analytics:get-consent-snapshot')
    .catch(() => null)
  if (snapshot) {
    trackEvent('analytics_state_at_consent', { ...snapshot })
  }
}

export async function trackDailyActiveIfNeeded(): Promise<void> {
  if (!hasElectronApi()) return
  const result = await window.electronAPI.invoke('analytics:mark-daily-active').catch(() => null)
  if (result?.tracked) {
    trackEvent('daily_active', {
      days_since_first_launch: result.daysSinceFirstLaunch
    })
  }
}

export async function startAnalyticsSession(): Promise<void> {
  if (!hasElectronApi()) return
  const result = await window.electronAPI.invoke('analytics:start-session').catch(() => null)
  if (result) {
    trackEvent('session_started', {
      session_id: result.sessionId,
      days_since_first_launch: result.daysSinceFirstLaunch
    })
  }
}

export async function endAnalyticsSession(): Promise<void> {
  if (!hasElectronApi()) return
  const result = await window.electronAPI.invoke('analytics:end-session').catch(() => null)
  if (result) {
    trackEvent('session_ended', {
      session_id: result.sessionId,
      session_duration_bucket: result.sessionDurationBucket
    })
  }
}

/**
 * Shutdown PostHog cleanly.
 */
export function shutdownAnalytics(): void {
  if (!initialized) return
  posthog.reset()
  identifiedInstallId = null
}
