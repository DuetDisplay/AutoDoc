import { useCallback, useEffect, useRef, useState } from 'react'
import type { WhisperSetupStatus } from '../../../../shared/types'
import {
  normalizeMeetingLanguage,
  type MeetingLanguageCode
} from '../../../../shared/meeting-language'
import { getWhisperSetupLabel } from '../../services/setup-status-labels'
import { toDurationBucket, trackEvent, trackFirstEventOnce } from '../../services/analytics'

const AUTO_RETRY_DELAY_MS = 1500
const SHOW_SKIP_DELAY_MS = 1500
const MAX_AUTO_RETRY_ATTEMPTS = 2

const phaseLabels: Record<string, (percent: number) => string> = {
  checking: () => 'Checking transcription setup...',
  'preparing-speaker-runtime': (p) => `Preparing speaker identification runtime... ${p}%`,
  'installing-speaker-id': (p) => `Installing speaker identification... ${p}%`,
  'downloading-speaker-model': (p) => `Downloading speaker identification model... ${p}%`
}

export function TranscriptionStep({
  onNext,
  onChooseLanguage
}: {
  onNext: () => void
  onChooseLanguage?: () => void
}) {
  const [phase, setPhase] = useState<string>('checking')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [lockedReason, setLockedReason] = useState<string | null>(null)
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
    setLockedReason(null)
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
        setLockedReason(null)
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
              setLockedReason(availability.reason ?? "This language isn't available on this PC.")
            })
            .catch(() => {})
        }
        return
      }

      if (status.phase !== 'checking' && status.percent > 0) {
        hasSeenMeaningfulSetupProgress.current = true
      }

      setError(null)
      setLockedReason(null)
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

  if (phase === 'ready') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-sage-light flex items-center justify-center mx-auto mb-5">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#4A6B4E"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
          Transcription Ready
        </h2>
        <p className={`text-[14px] text-ink-muted leading-relaxed ${cpuSlower ? 'mb-2' : 'mb-7'}`}>
          Your local transcription engine is installed and ready to go.
        </p>
        {cpuSlower && (
          <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
            This PC will transcribe this language on the processor, so it will be slower.
          </p>
        )}
        <button
          onClick={onNext}
          className="px-6 py-2.5 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue
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
        Setting Up Transcription
      </h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc uses a local speech engine and local speaker identification to process meetings
        on-device. This downloads once and runs entirely on your machine.
      </p>

      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">
        {lockedReason ??
          getWhisperSetupLabel(setupStatus) ??
          phaseLabels[phase]?.(percent) ??
          (error ? `Setup failed: ${error}` : 'Preparing...')}
      </div>

      {isLowSpecHost && (
        <div className="max-w-[390px] mx-auto mb-5 rounded-[16px] border border-sage/25 bg-sage-light/45 p-4 text-left">
          <h3 className="text-[14px] font-semibold text-ink mb-2">
            {isLowSpecWindows ? 'Optimized for this PC' : 'Optimized for this Mac'}
          </h3>
          <p className="text-[13px] text-ink-muted leading-relaxed mb-2">
            AutoDoc detected that this {isLowSpecWindows ? 'PC' : 'Mac'} has limited memory, so we
            will use a lower-impact local processing mode. Transcription and notes may take longer,
            but this helps keep recording reliable while everything stays on your device.
          </p>
          <p className="text-[12px] text-ink-faint leading-relaxed">
            AutoDoc will process mic and system audio one at a time on this{' '}
            {isLowSpecWindows ? 'PC' : 'Mac'} to reduce memory pressure.
          </p>
        </div>
      )}

      {isAutoRetrying && (
        <div className="max-w-[360px] mx-auto mb-5 rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
          <h3 className="text-[14px] font-semibold text-ink mb-2">
            Still finishing transcription setup
          </h3>
          <p className="text-[13px] text-ink-muted leading-relaxed">
            AutoDoc is retrying automatically in the background so you can keep moving.
          </p>
        </div>
      )}

      {lockedReason && (
        <div className="flex flex-col items-center gap-3">
          <div className="max-w-[360px] mx-auto rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
            <h3 className="text-[14px] font-semibold text-ink mb-2">
              {"This language isn't available on this PC"}
            </h3>
            <p className="text-[13px] text-ink-muted leading-relaxed">{lockedReason}</p>
          </div>
          {onChooseLanguage && (
            <button
              onClick={onChooseLanguage}
              className="px-6 py-2.5 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
            >
              Choose another language
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3">
          <div className="max-w-[360px] mx-auto rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
            <h3 className="text-[14px] font-semibold text-ink mb-2">
              Transcription setup is taking longer than expected
            </h3>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              You can continue and AutoDoc will keep working on this in the background, or retry
              right now.
            </p>
          </div>
          <button
            onClick={async () => {
              clearRetryTimer()
              autoRetryAttempts.current = 0
              hasSeenMeaningfulSetupProgress.current = false
              setError(null)
              setLockedReason(null)
              setIsAutoRetrying(false)
              setPhase('checking')
              setPercent(0)
              setSetupStatus({ phase: 'checking', percent: 0 })
              await window.electronAPI.invoke('whisper:retry-setup')
            }}
            className="px-6 py-2.5 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            Retry
          </button>
          {onChooseLanguage && meetingLanguage && meetingLanguage !== 'en' && (
            <button
              onClick={onChooseLanguage}
              className="text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
            >
              Choose another language
            </button>
          )}
        </div>
      )}

      {showSkip && !lockedReason && (
        <button
          onClick={onNext}
          className="text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
        >
          Continue - this will finish in the background
        </button>
      )}
    </div>
  )
}
