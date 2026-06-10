import { beforeEach, describe, expect, it, vi } from 'vitest'

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn()
}))

vi.mock('posthog-js', () => ({
  default: posthogMock
}))

async function loadAnalytics() {
  vi.resetModules()
  return await import('../analytics')
}

describe('analytics consent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_POSTHOG_KEY', 'ph_test_key')
  })

  it('records the consent event only when analytics are enabled', async () => {
    const { initAnalytics, setAnalyticsConsent } = await loadAnalytics()

    initAnalytics()
    setAnalyticsConsent(true)

    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1)
    expect(posthogMock.capture).toHaveBeenCalledWith('analytics_consent', {
      consented: true
    })
  })

  it('does not emit analytics when consent is declined', async () => {
    const { initAnalytics, setAnalyticsConsent, trackEvent } = await loadAnalytics()

    initAnalytics()
    setAnalyticsConsent(false)
    trackEvent('app_opened')

    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled()
    expect(posthogMock.capture).not.toHaveBeenCalled()
  })
})
