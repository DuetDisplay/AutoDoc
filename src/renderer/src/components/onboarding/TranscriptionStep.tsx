import { meetingLanguageName } from '../../services/meeting-language-name'
import { useT } from '../../services/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WhisperSetupStatus } from '../../../../shared/types'
import {
  normalizeMeetingLanguage,
  type MeetingLanguageCode
} from '../../../../shared/meeting-language'
import { getWhisperSetupLabel } from '../../services/setup-status-labels'
import { toDurationBucket, trackEvent, trackFirstEventOnce } from '../../services/analytics'
import { isNetworkErrorMessage } from '../../services/network-errors'

const AUTO_RETRY_DELAY_MS = 1500
const SHOW_SKIP_DELAY_MS = 1500
const MAX_AUTO_RETRY_ATTEMPTS = 2

export function TranscriptionStep({
  onNext,
  onChooseLanguage
}: {
  onNext: () => void
  onChooseLanguage?: () => void
}) {
  const t = useT()

  const [phase, setPhase] = useState<string>('checking')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [languageLocked, setLanguageLocked] = useState(false)
  const [cpuSlower, setCpuSlower] = useState(false)
  const [meetingLanguage, setMeetingLanguage] = useState<MeetingLanguageCode | null>(null)
  const [setupStatus, setSetupStatus] = useState<WhisperSetupStatus>({
    phase: 'checking',
    percent: 0
  })
  const [isAutoRetrying, setIsAutoRetrying] = useState(false)
  const [showSkip, setShowSkip] = useState(false)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRetryAttempts = useRef(0)
  const hasSeenMeaningfulSetupProgress = useRef(false)
  const setupStartedAt = useRef<number | null>(null)
  const lastFailureKey = useRef<string | null>(null)
  const meetingLanguageRef = useRef<MeetingLanguageCode | null>(null)
  const isLowSpecMac = setupStatus.macProcessingProfileId === 'mac-low-spec'
  const isLowSpecWindows = setupStatus.windowsProcessingProfileId === 'win-low-spec'
  const isLowSpecHost = isLowSpecMac || isLowSpecWindows

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
  }, [])

  const markReady = useCallback(() => {
    setPhase('ready')
    setPercent(100)
    setSetupStatus({ phase: 'ready', percent: 100 })
    setError(null)
    setLanguageLocked(false)
    setIsAutoRetrying(false)
    autoRetryAttempts.current = 0
    hasSeenMeaningfulSetupProgress.current = false
    lastFailureKey.current = null
    clearRetryTimer()
    const startedAt = setupStartedAt.current ?? performance.now()
    void trackFirstEventOnce('whisper_setup_completed', 'setup_component_completed', {
      component: 'whisper',
      duration_bucket: toDurationBucket((performance.now() - startedAt) / 1000)
    })
  }, [clearRetryTimer])

  const scheduleAutoRetry = useCallback(() => {
    if (autoRetryAttempts.current >= MAX_AUTO_RETRY_ATTEMPTS || retryTimer.current) {
      return
    }

    setError(null)
    setIsAutoRetrying(true)
    setPhase('checking')
    setPercent(0)
    setSetupStatus({ phase: 'checking', percent: 0 })

    retryTimer.current = setTimeout(async () => {
      retryTimer.current = null
      autoRetryAttempts.current += 1
      await window.electronAPI.invoke('whisper:retry-setup')
    }, AUTO_RETRY_DELAY_MS)
  }, [])

  const applyStatus = useCallback(
    async (status: WhisperSetupStatus, allowKickoff = false) => {
      setSetupStatus(status)
      setPhase(status.phase)
      setPercent(status.percent)

      if (status.phase === 'ready') {
        markReady()
        return
      }

      if (status.phase === 'error') {
        const failedStep = status.failedStep ?? 'unknown'
        const failureKey = `${failedStep}:${status.error ?? ''}:${autoRetryAttempts.current}`
        if (lastFailureKey.current !== failureKey) {
          lastFailureKey.current = failureKey
          trackEvent('setup_component_failed', {
            component: 'whisper',
            phase: failedStep,
            failure_code: failedStep,
            attempt_number: autoRetryAttempts.current + 1
          })
        }
        setLanguageLocked(false)
        scheduleAutoRetry()
        if (autoRetryAttempts.current >= MAX_AUTO_RETRY_ATTEMPTS) {
          setIsAutoRetrying(false)
          setError(status.error ?? 'Unknown error')
        }
        // The lock check must not hold up retrying: a slow availability answer
        // used to leave the step with neither progress nor a Retry button.
        const language = meetingLanguageRef.current
        if (language && language !== 'en') {
          void window.electronAPI
            .invoke('whisper:get-windows-meeting-language-availability', language)
            .then((availability) => {
              if (availability.availability !== 'locked') return
              clearRetryTimer()
              setIsAutoRetrying(false)
              setError(null)
              setLanguageLocked(true)
            })
            .catch(() => {})
        }
        return
      }

      if (status.phase !== 'checking' && status.percent > 0) {
        hasSeenMeaningfulSetupProgress.current = true
      }

      setError(null)
      setLanguageLocked(false)
      setIsAutoRetrying(false)
      if (hasSeenMeaningfulSetupProgress.current && status.phase !== 'checking') {
        autoRetryAttempts.current = 0
        hasSeenMeaningfulSetupProgress.current = false
      }
      clearRetryTimer()

      if (allowKickoff && status.phase === 'checking') {
        await window.electronAPI.invoke('whisper:retry-setup')
      }
    },
    [clearRetryTimer, markReady, scheduleAutoRetry]
  )

  useEffect(() => {
    setupStartedAt.current ??= performance.now()
    trackEvent('setup_component_started', { component: 'whisper', phase: 'checking' })
    let mounted = true
    const selectedLanguage = window.electronAPI
      .invoke('prefs:get-meeting-language')
      .then((value) => {
        const language = normalizeMeetingLanguage(value)
        meetingLanguageRef.current = language
        if (mounted) setMeetingLanguage(language)
        return language
      })
    window.electronAPI.invoke('whisper:get-setup-status').then(async (status) => {
      const language = await selectedLanguage
      if (!mounted) return
      await applyStatus(
        status.meetingLanguage && status.meetingLanguage !== language
          ? { phase: 'checking', percent: 0 }
          : status,
        true
      )
    })

    const unsub = window.electronAPI.on('whisper:setup-progress', async (status) => {
      const language = await selectedLanguage
      if (mounted && (!status.meetingLanguage || status.meetingLanguage === language)) {
        await applyStatus(status)
      }
    })

    return () => {
      mounted = false
      unsub()
      clearRetryTimer()
    }
  }, [applyStatus, clearRetryTimer])

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), SHOW_SKIP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (phase !== 'ready' || !meetingLanguage || meetingLanguage === 'en') {
      return
    }
    let cancelled = false
    void window.electronAPI
      .invoke('whisper:get-windows-meeting-language-availability', meetingLanguage)
      .then((info) => {
        if (!cancelled && info.availability === 'slower') {
          setCpuSlower(true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [phase, meetingLanguage])

  // A failed download because the machine is offline gets its own message.
  const lockedReason = languageLocked ? t('ui.thisLanguageIsnTAvailableOnThisPC2') : null
  const networkFailure = isNetworkErrorMessage(error ?? setupStatus.error)
  const languageLabel = meetingLanguageName(meetingLanguage ?? 'en')

  if (phase === 'ready') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-sage-light flex items-center justify-center mx-auto mb-5">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            className="text-sage-dark"
            aria-hidden="true"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
          {t('ui.transcriptionReady')}
        </h2>
        <p className={`text-[14px] text-ink-muted leading-relaxed ${cpuSlower ? 'mb-2' : 'mb-7'}`}>
          {t('ui.yourLocalTranscriptionEngineIsInstalledAndReadyToGo')}
        </p>
        {cpuSlower && (
          <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
            {t('ui.thisPCWillTranscribeThisLanguageOnTheProcessorSoItWillBeSlower')}
          </p>
        )}
        <button
          onClick={onNext}
          className="i18n-btn px-6 py-2.5 bg-sage text-on-brand rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          {t('ui.continue')}
        </button>
      </div>
    )
  }

  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-mist-light flex items-center justify-center text-[28px] mx-auto mb-5">
        📝
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
        {t('ui.settingUpTranscription')}
      </h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        {t('ui.autoDocUsesALocalSpeechEngineAndLocalSpeakerIdentificationToProcessMeetings')}
      </p>

      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">
        {lockedReason ??
          (networkFailure ? t('ui.noInternetConnection') : null) ??
          getWhisperSetupLabel(setupStatus, t) ??
          (error ? t('setup.transcriptionFailed') : t('ui.preparing'))}
      </div>

      {isLowSpecHost && (
        <div className="max-w-[390px] mx-auto mb-5 rounded-[16px] border border-sage/25 bg-sage-light/45 p-4 text-left">
          <h3 className="text-[14px] font-semibold text-ink mb-2">
            {isLowSpecWindows ? t('ui.optimizedForThisPC') : t('ui.optimizedForThisMac')}
          </h3>
          <p className="text-[13px] text-ink-muted leading-relaxed mb-2">
            {t('ui.thisComputerHasLimitedMemorySoAutoDocWillProcessRecordingsMoreCarefullyTran')}
          </p>
          <p className="text-[12px] text-ink-faint leading-relaxed">
            {t('ui.autoDocWillProcessMicrophoneAndSystemAudioOneAtATimeToReduceMemoryPressure')}
          </p>
        </div>
      )}

      {isAutoRetrying && (
        <div className="max-w-[360px] mx-auto mb-5 rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
          <h3 className="text-[14px] font-semibold text-ink mb-2">
            {t('ui.stillFinishingTranscriptionSetup')}
          </h3>
          <p className="text-[13px] text-ink-muted leading-relaxed">
            {t('ui.autoDocIsRetryingAutomaticallyInTheBackgroundSoYouCanKeepMoving')}
          </p>
        </div>
      )}

      {lockedReason && (
        <div className="flex flex-col items-center gap-3">
          <div className="max-w-[360px] mx-auto rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
            <h3 className="text-[14px] font-semibold text-ink mb-2">
              {t('ui.thisLanguageIsnTAvailableOnThisPC')}
            </h3>
            <p className="text-[13px] text-ink-muted leading-relaxed">{lockedReason}</p>
          </div>
          {onChooseLanguage && (
            <button
              onClick={onChooseLanguage}
              className="i18n-btn px-6 py-2.5 bg-ink text-on-ink rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
            >
              {t('ui.chooseAnotherLanguage')}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3">
          <div className="max-w-[360px] mx-auto rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
            <h3 className="text-[14px] font-semibold text-ink mb-2">
              {networkFailure
                ? t('ui.youReOffline')
                : t('ui.transcriptionSetupIsTakingLongerThanExpected')}
            </h3>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              {networkFailure
                ? t('ui.connectToTheInternetToDownloadTheLanguageSpeechModelThenPressRetry', {
                    language: languageLabel
                  })
                : t(
                    'ui.youCanContinueAndAutoDocWillKeepWorkingOnThisInTheBackgroundOrRetryRightNow'
                  )}
            </p>
          </div>
          <button
            onClick={async () => {
              clearRetryTimer()
              autoRetryAttempts.current = 0
              hasSeenMeaningfulSetupProgress.current = false
              setError(null)
              setLanguageLocked(false)
              setIsAutoRetrying(false)
              setPhase('checking')
              setPercent(0)
              setSetupStatus({ phase: 'checking', percent: 0 })
              await window.electronAPI.invoke('whisper:retry-setup')
            }}
            className="i18n-btn px-6 py-2.5 bg-ink text-on-ink rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            {t('ui.retry')}
          </button>
          {onChooseLanguage && meetingLanguage && meetingLanguage !== 'en' && (
            <button
              onClick={onChooseLanguage}
              className="text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
            >
              {t('ui.chooseAnotherLanguage')}
            </button>
          )}
        </div>
      )}

      {showSkip && !lockedReason && (
        <button
          onClick={onNext}
          className="text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
        >
          {t('ui.continueThisWillFinishInTheBackground')}
        </button>
      )}
    </div>
  )
}
