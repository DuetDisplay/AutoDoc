import { useEffect, useRef, useState } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Upcoming } from './pages/Upcoming'
import { Recordings } from './pages/Recordings'
import { MeetingDetail } from './pages/MeetingDetail'
import { Search } from './pages/Search'
import { AskAI } from './pages/AskAI'
import { Settings } from './pages/Settings'
import { ROUTES } from '../../shared/constants'
import { useRecording } from './hooks/useRecording'
import {
  buildRecordingSelectionContext,
  buildRecordingTrackingContext,
  chooseAutoRecordSource,
  findActiveCalendarEvent
} from './services/window-detection'
import { RecordingBanner } from './components/RecordingBanner'
import { MeetingDetectedBanner } from './components/MeetingDetectedBanner'
import { PermissionToast } from './components/PermissionToast'
import { LowSpecMacProcessingBanner } from './components/LowSpecMacProcessingBanner'
import { Onboarding } from './pages/Onboarding'
import type { UpdateStatus } from '../../preload/ipc.d'
import {
  endAnalyticsSession,
  identifyConsentedInstall,
  initAnalytics,
  restoreAnalyticsConsent,
  setAnalyticsContext,
  startAnalyticsSession,
  toDurationBucket,
  trackDailyActiveIfNeeded,
  trackEvent,
  trackFirstEventOnce
} from './services/analytics'
import { recordDiagnosticAction, setDiagnosticConsentEnabled } from './services/diagnostic-trail'
import { updateRendererSentryConsent } from './services/renderer-sentry'
import { useCalendarStore } from './stores/calendar'
import { getSavedSourcePreference } from './services/recording-source-preferences'
import { useRecordingPickerStore } from './stores/recording-picker'
import type { AppRuntimeInfo } from '../../shared/types'

function RouteDiagnosticTracker() {
  const location = useLocation()

  useEffect(() => {
    recordDiagnosticAction({
      category: 'navigation',
      action: 'route_viewed',
      details: {
        path: location.pathname
      }
    })
  }, [location.pathname])

  return null
}

function UpdateReadyPrompt() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false

    window.electronAPI.invoke('updater:get-status').then((status) => {
      if (!cancelled) {
        setUpdateStatus(status)
      }
    })

    const unsubscribeStatus = window.electronAPI.on('updater:status', (status) => {
      setUpdateStatus(status)
      if (status.state !== 'downloaded') {
        setDismissedVersion(null)
      }
    })
    const unsubscribeOpenSettings = window.electronAPI.on('updater:open-settings', () => {
      window.location.hash = `#${ROUTES.settings}`
    })

    return () => {
      cancelled = true
      unsubscribeStatus()
      unsubscribeOpenSettings()
    }
  }, [])

  if (
    !updateStatus ||
    (updateStatus.state !== 'downloaded' && updateStatus.state !== 'installing')
  ) {
    return null
  }

  const version = updateStatus.version ?? 'unknown'
  const isInstalling = updateStatus.state === 'installing'

  if (!isInstalling && dismissedVersion === version) {
    return null
  }

  const handleRestart = () => {
    setUpdateStatus({ state: 'installing', version: updateStatus.version })
    trackEvent('update_install_requested', {
      available_version: updateStatus.version ?? 'unknown',
      surface: location.pathname === ROUTES.settings ? 'settings' : 'update_prompt'
    })
    window.setTimeout(() => {
      void window.electronAPI.invoke('updater:install')
    }, 300)
  }

  return (
    <div className="mx-6 mt-2 mb-0 bg-bg-card border border-sage/30 rounded-lg px-4 py-3 flex items-center gap-3 shadow-sm animate-[slideDown_300ms_ease]">
      <span className="h-2 w-2 rounded-full bg-sage" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-ink">
          {isInstalling ? 'Restarting...' : 'Update ready'}
        </p>
        <p className="text-[11px] text-ink-muted">
          {isInstalling
            ? 'AutoDoc will reopen after the update installs.'
            : `Restart AutoDoc to install v${version}.`}
        </p>
      </div>
      {!isInstalling && (
        <button
          type="button"
          onClick={() => setDismissedVersion(version)}
          className="text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
        >
          Later
        </button>
      )}
      <button
        type="button"
        onClick={handleRestart}
        disabled={isInstalling}
        className="text-[12px] font-semibold text-white bg-sage px-3 py-1.5 rounded-lg hover:bg-sage-dark transition-colors disabled:opacity-60"
      >
        {isInstalling ? 'Restarting...' : 'Restart'}
      </button>
    </div>
  )
}

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
  const { isRecording, sourceName, elapsedSeconds, handleStop, fetchSources, handleStart } =
    useRecording()
  const { events, setAccounts, setEvents } = useCalendarStore()
  const transcriptionFailures = useRef<Record<string, string>>({})
  const transcriptionCompletions = useRef<Set<string>>(new Set())
  const transcriptionStarted = useRef<Record<string, number>>({})
  const segmentationFailures = useRef<Record<string, string>>({})
  const segmentationCompletions = useRef<Set<string>>(new Set())
  const segmentationNoNotes = useRef<Set<string>>(new Set())
  const notesGenerationStarted = useRef<Record<string, number>>({})
  const whisperFailureKey = useRef<string | null>(null)
  const ollamaFailureKey = useRef<string | null>(null)
  const autoRecordStartInFlight = useRef(false)
  const runtimeInfoRef = useRef<AppRuntimeInfo | null>(null)

  useEffect(() => {
    // Initialize analytics early (stays opted-out until consent is restored/given)
    initAnalytics()

    window.electronAPI.invoke('prefs:get-onboarding-complete').then(setOnboardingDone)

    // Restore analytics consent for returning users
    void (async () => {
      const [consent, runtimeInfo] = await Promise.all([
        window.electronAPI.invoke('prefs:get-analytics-consent'),
        window.electronAPI.invoke('app:get-runtime-info').catch(() => null)
      ])

      if (runtimeInfo) {
        runtimeInfoRef.current = runtimeInfo
        setAnalyticsContext(runtimeInfo)
      }

      restoreAnalyticsConsent(consent === true)
      setDiagnosticConsentEnabled(consent === true)
      updateRendererSentryConsent(consent === true)
      if (consent === true) {
        await identifyConsentedInstall()
        recordDiagnosticAction({
          category: 'app',
          action: 'app_opened'
        })
        trackEvent('app_opened')
        await startAnalyticsSession()
        await trackDailyActiveIfNeeded()
      }
    })()

    const unsubConsent = window.electronAPI.on('prefs:analytics-consent-changed', (enabled) => {
      restoreAnalyticsConsent(enabled)
      setDiagnosticConsentEnabled(enabled)
      updateRendererSentryConsent(enabled)
    })
    let unsubE2ETrackAnalytics: (() => void) | null = null
    let disposed = false
    void window.electronAPI
      .invoke('e2e:get-detection-state')
      .then(() => {
        const unsubscribe = window.electronAPI.on(
          'e2e:track-analytics-event',
          ({ event, properties }) => {
            trackEvent(event, properties)
          }
        )
        if (disposed) {
          unsubscribe()
        } else {
          unsubE2ETrackAnalytics = unsubscribe
        }
      })
      .catch(() => {})

    const handleBeforeUnload = () => {
      void endAnalyticsSession()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      void endAnalyticsSession()
      unsubConsent()
      disposed = true
      unsubE2ETrackAnalytics?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const syncCalendarState = async () => {
      try {
        const accounts = await window.electronAPI.invoke('calendar:get-accounts')
        if (cancelled) return
        setAccounts(accounts)

        if (accounts.length === 0) {
          setEvents([])
          return
        }

        const events = await window.electronAPI.invoke('calendar:get-events')
        if (cancelled) return
        setEvents(events)
      } catch (err) {
        console.error('Failed to sync calendar state:', err)
      }
    }

    void syncCalendarState()

    const unsubscribeEvents = window.electronAPI.on('calendar:events-updated', (events) => {
      setEvents(events)
    })
    const unsubscribeConnection = window.electronAPI.on('calendar:connection-changed', () => {
      void syncCalendarState()
    })

    return () => {
      cancelled = true
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [setAccounts, setEvents])

  useEffect(() => {
    const unsubTranscription = window.electronAPI.on('transcription:status-changed', (payload) => {
      if (payload.status !== 'failed') {
        delete transcriptionFailures.current[payload.meetingId]
      }

      if (
        (payload.status === 'downloading' ||
          payload.status === 'transcribing' ||
          payload.status === 'diarizing') &&
        transcriptionStarted.current[payload.meetingId] === undefined
      ) {
        transcriptionStarted.current[payload.meetingId] = performance.now()
        trackEvent('transcription_started', {
          backend: runtimeInfoRef.current?.transcriptionBackend ?? 'unknown',
          model: runtimeInfoRef.current?.whisperModel ?? 'unknown'
        })
      }

      if (payload.status === 'complete') {
        if (!transcriptionCompletions.current.has(payload.meetingId)) {
          transcriptionCompletions.current.add(payload.meetingId)
          const startedAt = transcriptionStarted.current[payload.meetingId]
          delete transcriptionStarted.current[payload.meetingId]
          trackEvent('transcription_completed', {
            backend: runtimeInfoRef.current?.transcriptionBackend ?? 'unknown',
            model: runtimeInfoRef.current?.whisperModel ?? 'unknown',
            processing_time_bucket:
              startedAt === undefined
                ? undefined
                : toDurationBucket((performance.now() - startedAt) / 1000)
          })
        }
        return
      }

      if (payload.status !== 'failed') return

      const errorCode = payload.errorCode ?? 'unknown'
      if (transcriptionFailures.current[payload.meetingId] === errorCode) return
      transcriptionFailures.current[payload.meetingId] = errorCode
      delete transcriptionStarted.current[payload.meetingId]
      trackEvent('transcription_failed', {
        backend: runtimeInfoRef.current?.transcriptionBackend ?? 'unknown',
        model: runtimeInfoRef.current?.whisperModel ?? 'unknown',
        failure_code: errorCode
      })
    })

    const unsubSegmentation = window.electronAPI.on('segmentation:status-changed', (payload) => {
      if (payload.status !== 'failed') {
        delete segmentationFailures.current[payload.meetingId]
      }

      if (
        (payload.status === 'downloading-model' || payload.status === 'segmenting') &&
        notesGenerationStarted.current[payload.meetingId] === undefined
      ) {
        notesGenerationStarted.current[payload.meetingId] = performance.now()
        trackEvent('notes_generation_started')
      }

      if (payload.status === 'complete') {
        if (!segmentationCompletions.current.has(payload.meetingId)) {
          segmentationCompletions.current.add(payload.meetingId)
          const startedAt = notesGenerationStarted.current[payload.meetingId]
          delete notesGenerationStarted.current[payload.meetingId]
          trackEvent('notes_generated', {
            processing_time_bucket:
              startedAt === undefined
                ? undefined
                : toDurationBucket((performance.now() - startedAt) / 1000)
          })
          void trackFirstEventOnce('notes_generated', 'first_notes_generated')
          void trackFirstEventOnce('user_activated', 'user_activated', {
            activation_reason: 'first_notes_generated'
          })
        }
        return
      }

      if (payload.status === 'no-notes') {
        if (!segmentationNoNotes.current.has(payload.meetingId)) {
          segmentationNoNotes.current.add(payload.meetingId)
          delete notesGenerationStarted.current[payload.meetingId]
          trackEvent('notes_not_generated', { reason_code: 'no_notes_detected' })
        }
        return
      }

      if (payload.status !== 'failed') return

      const errorCode = payload.errorCode ?? 'unknown'
      if (segmentationFailures.current[payload.meetingId] === errorCode) return
      segmentationFailures.current[payload.meetingId] = errorCode
      delete notesGenerationStarted.current[payload.meetingId]
      trackEvent('notes_generation_failed', { failure_code: errorCode })
    })

    const unsubWhisper = window.electronAPI.on('whisper:setup-progress', (status) => {
      if (status.phase !== 'error') {
        whisperFailureKey.current = null
        return
      }

      const failedStep = status.failedStep ?? 'unknown'
      const errorKey = `${failedStep}:${status.error ?? ''}`
      if (whisperFailureKey.current === errorKey) return
      whisperFailureKey.current = errorKey
      trackEvent('setup_component_failed', {
        component: 'whisper',
        phase: failedStep,
        failure_code: failedStep,
        attempt_number: 1
      })
    })

    const unsubOllama = window.electronAPI.on('ollama:setup-progress', (status) => {
      if (status.phase !== 'error') {
        ollamaFailureKey.current = null
        return
      }

      const failedStep = status.failedStep ?? 'unknown'
      const errorKey = `${failedStep}:${status.error ?? ''}`
      if (ollamaFailureKey.current === errorKey) return
      ollamaFailureKey.current = errorKey
      trackEvent('setup_component_failed', {
        component: 'ollama',
        phase: failedStep,
        failure_code: failedStep,
        attempt_number: 1
      })
    })

    const unsubSegmentationDiagnostic = window.electronAPI.on(
      'segmentation:diagnostic-event',
      (payload) => {
        trackEvent(`segmentation_${payload.event}`, {
          ...payload.properties
        })
      }
    )

    return () => {
      unsubTranscription()
      unsubSegmentation()
      unsubWhisper()
      unsubOllama()
      unsubSegmentationDiagnostic()
    }
  }, [])

  // Auto-start recording when user clicks "Start AI Notes" from floating notification
  useEffect(() => {
    if (isRecording) {
      autoRecordStartInFlight.current = false
    }
  }, [isRecording])

  useEffect(() => {
    const unsub = window.electronAPI.on(
      'detection:auto-record',
      ({ providerId, hasCalendarEvent }) => {
        void (async () => {
          if (isRecording || autoRecordStartInFlight.current) return
          autoRecordStartInFlight.current = true
          const activeEvent = findActiveCalendarEvent(events)
          const selectionContext = buildRecordingSelectionContext(activeEvent, providerId)
          recordDiagnosticAction({
            category: 'recording',
            action: 'auto_record_requested',
            details: {
              providerId,
              hasCalendarEvent
            }
          })
          try {
            const sources = await fetchSources()
            const selection = chooseAutoRecordSource(
              sources,
              selectionContext,
              getSavedSourcePreference(selectionContext)
            )

            if (selection.source && selection.confidence === 'high') {
              await handleStart(
                selection.source.id,
                selection.source.name,
                selectionContext,
                buildRecordingTrackingContext(
                  selection.source,
                  selection.source,
                  selectionContext,
                  'auto_record'
                )
              )
              return
            }

            recordDiagnosticAction({
              category: 'recording',
              action: 'meeting_window_detection_failed',
              details: {
                hasCalendarEvent,
                providerId: selection.providerHint,
                windowCount: selection.windowCount,
                browserWindowCount: selection.browserWindowCount,
                meetingWindowCount: selection.meetingWindowCount,
                selectionMethod: selection.method,
                selectionConfidence: selection.confidence
              }
            })
            trackEvent('meeting_window_detection_failed', {
              trigger: 'auto_record',
              has_calendar_event: hasCalendarEvent,
              provider_hint: selection.providerHint ?? 'unknown',
              window_count: selection.windowCount,
              browser_window_count: selection.browserWindowCount,
              meeting_window_count: selection.meetingWindowCount,
              selection_method: selection.method,
              selection_confidence: selection.confidence
            })

            useRecordingPickerStore.getState().openPicker({
              title: 'Select the meeting window',
              subtitle:
                'AutoDoc could not confidently identify the meeting window. Pick it manually instead of falling back to a screen capture.',
              sources,
              detectedId: selection.source?.id ?? null,
              suggestionLabel: selection.source ? 'Suggested window' : null
            })
            recordDiagnosticAction({
              category: 'recording',
              action: 'manual_source_selection_required',
              details: {
                trigger: 'auto_record',
                hasSuggestion: selection.source !== null
              }
            })
            trackEvent('recording_manual_source_selection_required', {
              trigger: 'auto_record',
              has_suggestion: selection.source !== null,
              provider_hint: selection.providerHint ?? 'unknown'
            })
            window.location.hash = ROUTES.upcoming
          } catch (err) {
            autoRecordStartInFlight.current = false
            console.error('Auto-record failed:', err)
            return
          }
          autoRecordStartInFlight.current = false
        })()
      }
    )
    return unsub
  }, [events, isRecording, fetchSources, handleStart])

  useEffect(() => {
    return window.electronAPI.on('notes:open-meeting', ({ meetingId }) => {
      window.location.hash = `#${ROUTES.recordings}/${encodeURIComponent(meetingId)}`
    })
  }, [])

  // Auto-stop recording when meeting-end signals stay gone long enough to be convincing.
  useEffect(() => {
    const unsub = window.electronAPI.on('detection:auto-stop', (payload) => {
      void (async () => {
        if (!isRecording) return
        console.log('Auto-stopping recording — meeting ended')
        recordDiagnosticAction({
          category: 'recording',
          action: 'auto_stop_triggered',
          details: {
            reason: payload.reason,
            sourceType: payload.sourceType,
            providerDetected: payload.providerDetected,
            meetingWindowVisible: payload.meetingWindowVisible
          }
        })
        trackEvent('recording_auto_stopped', {
          reason: payload.reason,
          duration_seconds: elapsedSeconds,
          source_type: payload.sourceType,
          provider_detected: payload.providerDetected,
          meeting_window_visible: payload.meetingWindowVisible,
          window_missing_polls: payload.windowMissingPolls,
          provider_missing_polls: payload.providerMissingPolls,
          mic_silent_polls: payload.micSilentPolls
        })
        try {
          await handleStop()
        } catch (err) {
          console.error('Auto-stop failed:', err)
        }
      })()
    })
    const unsubCancelled = window.electronAPI.on('detection:auto-stop-cancelled', (payload) => {
      recordDiagnosticAction({
        category: 'recording',
        action: 'auto_stop_cancelled',
        details: {
          reason: payload.reason,
          recoveredSignals: payload.recoveredSignals.join(',')
        }
      })
      trackEvent('recording_auto_stop_cancelled', {
        reason: payload.reason,
        source_type: payload.sourceType,
        provider_detected: payload.providerDetected,
        meeting_window_visible: payload.meetingWindowVisible,
        window_missing_polls: payload.windowMissingPolls,
        provider_missing_polls: payload.providerMissingPolls,
        mic_silent_polls: payload.micSilentPolls,
        recovered_signals: payload.recoveredSignals.join(',')
      })
    })
    return () => {
      unsub()
      unsubCancelled()
    }
  }, [elapsedSeconds, handleStop, isRecording])

  if (onboardingDone === null) return null

  if (!onboardingDone) {
    return <Onboarding onComplete={() => setOnboardingDone(true)} />
  }

  return (
    <HashRouter>
      <RouteDiagnosticTracker />
      <div className="flex h-screen bg-bg-primary relative">
        {/* Top drag region for moving the window */}
        <div
          className="absolute top-0 left-0 right-0 h-[52px] z-10"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        <Sidebar />
        <main className="flex-1 overflow-hidden flex flex-col pt-[52px]">
          <RecordingBanner
            isRecording={isRecording}
            elapsedSeconds={elapsedSeconds}
            sourceName={sourceName}
            onStop={handleStop}
          />
          <MeetingDetectedBanner />
          <PermissionToast />
          <LowSpecMacProcessingBanner />
          <UpdateReadyPrompt />
          <div className="flex-1 overflow-hidden">
            <Routes>
              <Route path={ROUTES.upcoming} element={<Upcoming />} />
              <Route path={ROUTES.recordings} element={<Recordings />} />
              <Route path={ROUTES.meetingDetail} element={<MeetingDetail />} />
              <Route path={ROUTES.search} element={<Search />} />
              <Route path={ROUTES.askAi} element={<AskAI />} />
              <Route path={ROUTES.settings} element={<Settings />} />
            </Routes>
          </div>
        </main>
      </div>
    </HashRouter>
  )
}
