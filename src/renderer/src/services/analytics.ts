import posthog from 'posthog-js'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com'

let initialized = false
let consentGiven = false

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
    opt_out_capturing_by_default: true,
  })
  initialized = true
}

/**
 * Call when the user makes their analytics choice.
 * We always fire the consent event itself (before opting out) so we can measure opt-in rate.
 */
export function setAnalyticsConsent(enabled: boolean): void {
  if (!initialized) return
  // Temporarily opt in to capture the consent event itself
  posthog.opt_in_capturing()
  posthog.capture('analytics_consent', { consented: enabled })

  if (enabled) {
    consentGiven = true
  } else {
    // Flush the consent event, then opt out
    consentGiven = false
    // Small delay to ensure the consent event is sent before opting out
    setTimeout(() => posthog.opt_out_capturing(), 500)
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
  posthog.capture(event, {
    platform: 'desktop',
    ...properties,
  })
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
