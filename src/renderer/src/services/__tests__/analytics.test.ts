import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeInfo, installMockElectronApi } from '../../test/fixtures'

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
    installMockElectronApi({
      'analytics:get-state': {
        installId: 'install-123',
        firstLaunchDate: new Date().toISOString(),
        lastDailyActiveDate: null,
        sessionId: null,
        sessionStartedAt: null,
        onboardingStarted: false,
        onboardingCompleted: false,
        whisperSetupCompleted: false,
        ollamaSetupCompleted: false,
        setupCompleted: false,
        firstRecordingCompleted: false,
        firstNotesGenerated: false,
        userActivated: false,
        recordingsCompletedCount: 0,
        notesGeneratedCount: 0,
        firstSeenAppVersion: '1.1.0',
        lastSeenAppVersion: '1.1.0',
        pendingUpgradeFromVersion: null,
        pendingUpgradeToVersion: null
      },
      'analytics:get-consent-snapshot': {
        days_since_first_launch: 2,
        onboarding_started: true,
        onboarding_completed: true,
        setup_completed: true,
        first_recording_completed: true,
        first_notes_generated: false,
        user_activated: true,
        recordings_completed_bucket: '2-3',
        notes_generated_bucket: '0'
      },
      'analytics:mark-daily-active': { tracked: true, daysSinceFirstLaunch: 2 },
      'analytics:start-session': { sessionId: 'session-123', daysSinceFirstLaunch: 2 },
      'analytics:end-session': { sessionId: 'session-123', sessionDurationBucket: '10-59s' },
      'analytics:record-local-signal': true,
      'analytics:get-pending-upgrade': null,
      'analytics:acknowledge-upgrade': true
    })
  })

  it('records the consent event only when analytics are enabled', async () => {
    const { identifyConsentedInstall, initAnalytics, setAnalyticsConsent, setAnalyticsContext } =
      await loadAnalytics()

    initAnalytics()
    setAnalyticsContext(createRuntimeInfo({ transcriptionBackend: 'mlx-whisper' }))
    await identifyConsentedInstall()
    await setAnalyticsConsent(true)

    expect(posthogMock.identify).toHaveBeenCalledWith('install-123')
    expect(posthogMock.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false })
    expect(posthogMock.capture).toHaveBeenCalledWith(
      'analytics_consent',
      {
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
      },
      {
        send_instantly: true
      }
    )
  })

  it('does not emit analytics when consent is declined', async () => {
    const { initAnalytics, setAnalyticsConsent, trackEvent } = await loadAnalytics()

    initAnalytics()
    await setAnalyticsConsent(false)
    trackEvent('app_opened')

    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled()
    expect(posthogMock.capture).not.toHaveBeenCalled()
  })

  it('sends only coarse consent snapshot properties after opt-in', async () => {
    const { initAnalytics, restoreAnalyticsConsent, trackConsentSnapshot } = await loadAnalytics()

    initAnalytics()
    restoreAnalyticsConsent(true)
    await trackConsentSnapshot()

    expect(posthogMock.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false })
    expect(posthogMock.capture).toHaveBeenCalledWith('analytics_state_at_consent', {
      platform: 'desktop',
      build_mode: 'test',
      build_channel: 'development',
      days_since_first_launch: 2,
      onboarding_started: true,
      onboarding_completed: true,
      setup_completed: true,
      first_recording_completed: true,
      first_notes_generated: false,
      user_activated: true,
      recordings_completed_bucket: '2-3',
      notes_generated_bucket: '0'
    })
  })

  it('sends a pending upgrade immediately after new consent and then acknowledges it', async () => {
    const transition = {
      previousVersion: '1.1.0',
      currentVersion: '1.1.1'
    }
    const api = installMockElectronApi({
      'analytics:get-pending-upgrade': transition,
      'analytics:acknowledge-upgrade': true
    })
    const { identifyConsentedInstall, initAnalytics, setAnalyticsConsent, setAnalyticsContext } =
      await loadAnalytics()

    initAnalytics()
    setAnalyticsContext(createRuntimeInfo({ appVersion: '1.1.1' }))
    await identifyConsentedInstall()
    await setAnalyticsConsent(true)

    expect(posthogMock.capture.mock.calls.map(([event]) => event)).toEqual([
      'analytics_consent',
      'app_updated'
    ])
    expect(posthogMock.capture).toHaveBeenNthCalledWith(2, 'app_updated', {
      platform: 'desktop',
      app_version: '1.1.1',
      app_platform: 'darwin',
      app_arch: 'arm64',
      official_build: true,
      build_channel: 'official',
      build_mode: 'test',
      whisper_model: 'ggml-base.en.bin',
      ollama_model: 'llama3.2:3b',
      current_version: '1.1.1',
      previous_version: '1.1.0',
      transition_source: 'disclosed-at-consent'
    })
    expect(api.invoke).toHaveBeenCalledWith('analytics:acknowledge-upgrade', transition)
  })

  it('labels an upgrade observed by a returning opted-in install', async () => {
    const transition = {
      previousVersion: '1.1.0',
      currentVersion: '1.1.1'
    }
    installMockElectronApi({
      'analytics:get-pending-upgrade': transition,
      'analytics:acknowledge-upgrade': true
    })
    const { initAnalytics, restoreAnalyticsConsent, setAnalyticsContext, trackPendingAppUpdate } =
      await loadAnalytics()

    initAnalytics()
    setAnalyticsContext(createRuntimeInfo({ appVersion: '1.1.1' }))
    restoreAnalyticsConsent(true)

    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(true)
    expect(posthogMock.capture).toHaveBeenCalledWith(
      'app_updated',
      expect.objectContaining({
        app_version: '1.1.1',
        current_version: '1.1.1',
        previous_version: '1.1.0',
        transition_source: 'observed-after-consent'
      })
    )
  })

  it('does not read or emit a pending version transition before consent', async () => {
    const api = installMockElectronApi({
      'analytics:get-pending-upgrade': {
        previousVersion: '1.1.0',
        currentVersion: '1.1.1'
      }
    })
    const { initAnalytics, trackPendingAppUpdate } = await loadAnalytics()

    initAnalytics()

    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(false)
    expect(api.invoke).not.toHaveBeenCalledWith('analytics:get-pending-upgrade')
    expect(posthogMock.capture).not.toHaveBeenCalled()
  })

  it('does not emit or acknowledge fresh-install and invalid transition snapshots', async () => {
    const invalidTransitions = [
      null,
      { previousVersion: 'not-semver', currentVersion: '1.1.1' },
      { previousVersion: '1.1.1', currentVersion: '1.1.1' },
      { previousVersion: '1.1.0', currentVersion: `1.1.1-${'a'.repeat(65)}` }
    ]

    for (const transition of invalidTransitions) {
      vi.clearAllMocks()
      const api = installMockElectronApi({
        'analytics:get-pending-upgrade': transition,
        'analytics:acknowledge-upgrade': true
      })
      const { initAnalytics, restoreAnalyticsConsent, trackPendingAppUpdate } =
        await loadAnalytics()
      initAnalytics()
      restoreAnalyticsConsent(true)

      await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(false)
      expect(posthogMock.capture).not.toHaveBeenCalled()
      expect(api.invoke).not.toHaveBeenCalledWith(
        'analytics:acknowledge-upgrade',
        expect.anything()
      )
    }
  })

  it('deduplicates a transition while an acknowledgement retry remains pending', async () => {
    const transition = {
      previousVersion: '1.1.0',
      currentVersion: '1.1.1'
    }
    installMockElectronApi({
      'analytics:get-pending-upgrade': transition,
      'analytics:acknowledge-upgrade': false
    })
    const { initAnalytics, restoreAnalyticsConsent, trackPendingAppUpdate } = await loadAnalytics()
    initAnalytics()
    restoreAnalyticsConsent(true)

    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(true)
    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(false)

    expect(
      posthogMock.capture.mock.calls.filter(([event]) => event === 'app_updated')
    ).toHaveLength(1)
  })

  it('acknowledges only after the upgrade event is accepted into the capture queue', async () => {
    const transition = {
      previousVersion: '1.1.0',
      currentVersion: '1.1.1'
    }
    const api = installMockElectronApi({
      'analytics:get-pending-upgrade': transition,
      'analytics:acknowledge-upgrade': true
    })
    const { initAnalytics, restoreAnalyticsConsent, trackPendingAppUpdate } = await loadAnalytics()
    initAnalytics()
    restoreAnalyticsConsent(true)
    posthogMock.capture.mockImplementationOnce(() => {
      throw new Error('queue unavailable')
    })

    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(false)
    expect(api.invoke).not.toHaveBeenCalledWith('analytics:acknowledge-upgrade', transition)

    await expect(trackPendingAppUpdate('observed-after-consent')).resolves.toBe(true)
    expect(api.invoke).toHaveBeenCalledWith('analytics:acknowledge-upgrade', transition)
  })

  it('drops forbidden and unknown sensitive-looking properties', async () => {
    const { sanitizeAnalyticsProperties } = await loadAnalytics()

    expect(
      sanitizeAnalyticsProperties({
        trigger: 'manual',
        transition_source: 'observed-after-consent',
        current_version: 'not-semver',
        previous_version: `1.1.0-${'a'.repeat(65)}`,
        meetingId: 'meeting-1',
        transcript_text: 'private transcript',
        filePath: '/Users/name/private.m4a',
        raw_log: 'debug',
        errorCode: 'permission_denied',
        result_count: 7,
        unexpected: 'value'
      })
    ).toEqual({
      trigger: 'manual',
      transition_source: 'observed-after-consent',
      failure_code: 'permission_denied',
      result_count_bucket: '4-10'
    })
  })

  it('emits daily_active only when the local store says today has not been tracked', async () => {
    const api = installMockElectronApi({
      'analytics:mark-daily-active': { tracked: false, daysSinceFirstLaunch: 3 }
    })
    const { initAnalytics, restoreAnalyticsConsent, trackDailyActiveIfNeeded } =
      await loadAnalytics()

    initAnalytics()
    restoreAnalyticsConsent(true)
    await trackDailyActiveIfNeeded()

    expect(api.invoke).toHaveBeenCalledWith('analytics:mark-daily-active')
    expect(posthogMock.capture).not.toHaveBeenCalled()
  })

  it('sends bucketed session start and end events', async () => {
    const { endAnalyticsSession, initAnalytics, restoreAnalyticsConsent, startAnalyticsSession } =
      await loadAnalytics()

    initAnalytics()
    restoreAnalyticsConsent(true)
    await startAnalyticsSession()
    await endAnalyticsSession()

    expect(posthogMock.capture).toHaveBeenCalledWith('session_started', {
      platform: 'desktop',
      build_mode: 'test',
      build_channel: 'development',
      session_id: 'session-123',
      days_since_first_launch: 2
    })
    expect(posthogMock.capture).toHaveBeenCalledWith('session_ended', {
      platform: 'desktop',
      build_mode: 'test',
      build_channel: 'development',
      session_id: 'session-123',
      session_duration_bucket: '10-59s'
    })
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
