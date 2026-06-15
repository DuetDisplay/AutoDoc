import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeInfo } from '../../test/fixtures'

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
    const { initAnalytics, setAnalyticsConsent, setAnalyticsContext } = await loadAnalytics()

    initAnalytics()
    setAnalyticsContext(createRuntimeInfo({ transcriptionBackend: 'mlx-whisper' }))
    setAnalyticsConsent(true)

    expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1)
    expect(posthogMock.capture).toHaveBeenCalledWith('analytics_consent', {
      platform: 'desktop',
      app_version: '0.1.24',
      app_platform: 'darwin',
      app_arch: 'arm64',
      official_build: true,
      build_channel: 'official',
      build_mode: 'test',
      transcription_backend: 'mlx-whisper',
      whisper_model: 'ggml-base.en.bin',
      ollama_model: 'llama3.2:3b',
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

  it('attaches release context to tracked events', async () => {
    const { initAnalytics, restoreAnalyticsConsent, setAnalyticsContext, trackEvent } =
      await loadAnalytics()

    initAnalytics()
    setAnalyticsContext(
      createRuntimeInfo({
        appVersion: '1.0.0',
        platform: 'win32',
        arch: 'x64',
        buildChannel: 'official',
        transcriptionBackend: 'faster-whisper-cuda'
      })
    )
    restoreAnalyticsConsent(true)
    trackEvent('recording_started', { trigger: 'manual' })

    expect(posthogMock.capture).toHaveBeenCalledWith('recording_started', {
      platform: 'desktop',
      app_version: '1.0.0',
      app_platform: 'win32',
      app_arch: 'x64',
      official_build: true,
      build_channel: 'official',
      build_mode: 'test',
      transcription_backend: 'faster-whisper-cuda',
      whisper_model: 'ggml-base.en.bin',
      ollama_model: 'llama3.2:3b',
      trigger: 'manual'
    })
  })
})
