import posthog from 'posthog-js'
import type { AppRuntimeInfo } from '../../../shared/types'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com'

let initialized = false
let consentGiven = false
let analyticsContext: Record<string, string | boolean | undefined> = {
  platform: 'desktop',
  build_mode: import.meta.env.MODE,
  build_channel: import.meta.env.DEV ? 'development' : 'custom'
}

function buildEventProperties(properties?: Record<string, unknown>): Record<string, unknown> {
  const mergedProperties = {
    ...analyticsContext,
    ...properties
  }
  return Object.fromEntries(
    Object.entries(mergedProperties).filter(([, value]) => value !== undefined)
  )
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
    opt_out_capturing_by_default: true
  })
  initialized = true
}

/**
 * Call when the user makes their analytics choice.
 * Declines must not emit analytics. Opt-ins record the consent event after enabling capture.
 */
export function setAnalyticsConsent(enabled: boolean): void {
  if (!initialized) return

  if (enabled) {
    consentGiven = true
    posthog.opt_in_capturing()
    posthog.capture('analytics_consent', buildEventProperties({ consented: true }))
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
    posthog.opt_in_capturing()
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

/**
 * Identify user (anonymous — we use a device-level distinct ID, no PII).
 */
export function identifyDevice(deviceId: string): void {
  if (!initialized) return
  posthog.identify(deviceId)
}

/**
 * Shutdown PostHog cleanly.
 */
export function shutdownAnalytics(): void {
  if (!initialized) return
  posthog.reset()
}
