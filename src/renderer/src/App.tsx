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
  chooseAutoRecordSource,
  findActiveCalendarEvent,
} from './services/window-detection'
import { RecordingBanner } from './components/RecordingBanner'
import { MeetingDetectedBanner } from './components/MeetingDetectedBanner'
import { PermissionToast } from './components/PermissionToast'
import { RecordingPickerOverlay } from './components/RecordingPickerOverlay'
import { Onboarding } from './pages/Onboarding'
import { initAnalytics, restoreAnalyticsConsent, trackEvent } from './services/analytics'
import { recordDiagnosticAction, setDiagnosticConsentEnabled } from './services/diagnostic-trail'
import { updateRendererSentryConsent } from './services/renderer-sentry'
import { useCalendarStore } from './stores/calendar'
import { getSavedSourcePreference } from './services/recording-source-preferences'
import { useRecordingPickerStore } from './stores/recording-picker'

function RouteDiagnosticTracker() {
  const location = useLocation()

  useEffect(() => {
    recordDiagnosticAction({
      category: 'navigation',
      action: 'route_viewed',
      details: {
        path: location.pathname,
      },
    })
  }, [location.pathname])

  return null
}

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
  const { isRecording, sourceName, elapsedSeconds, handleStop, fetchSources, handleStart } = useRecording()
  const { events, setAccounts, setEvents } = useCalendarStore()
  const transcriptionFailures = useRef<Record<string, string>>({})
  const segmentationFailures = useRef<Record<string, string>>({})
  const whisperFailureKey = useRef<string | null>(null)
  const ollamaFailureKey = useRef<string | null>(null)
  const autoRecordStartInFlight = useRef(false)

  useEffect(() => {
    // Initialize analytics early (stays opted-out until consent is restored/given)
    initAnalytics()

    window.electronAPI.invoke('prefs:get-onboarding-complete').then(setOnboardingDone)

    // Restore analytics consent for returning users
    window.electronAPI.invoke('prefs:get-analytics-consent').then((consent) => {
      restoreAnalyticsConsent(consent === true)
      setDiagnosticConsentEnabled(consent === true)
      updateRendererSentryConsent(consent === true)
      if (consent === true) {
        recordDiagnosticAction({
          category: 'app',
          action: 'app_opened',
        })
        trackEvent('app_opened')
      }
    })

    const unsubConsent = window.electronAPI.on('prefs:analytics-consent-changed', (enabled) => {
      restoreAnalyticsConsent(enabled)
      setDiagnosticConsentEnabled(enabled)
      updateRendererSentryConsent(enabled)
    })

    return unsubConsent
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
        return
      }

      const errorCode = payload.errorCode ?? 'unknown'
      if (transcriptionFailures.current[payload.meetingId] === errorCode) return
      transcriptionFailures.current[payload.meetingId] = errorCode
      trackEvent('transcription_failed', { meetingId: payload.meetingId, errorCode })
    })

    const unsubSegmentation = window.electronAPI.on('segmentation:status-changed', (payload) => {
      if (payload.status !== 'failed') {
        delete segmentationFailures.current[payload.meetingId]
        return
      }

      const errorCode = payload.errorCode ?? 'unknown'
      if (segmentationFailures.current[payload.meetingId] === errorCode) return
      segmentationFailures.current[payload.meetingId] = errorCode
      trackEvent('segmentation_failed', { meetingId: payload.meetingId, errorCode })
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
      trackEvent('whisper_setup_failed', { failed_step: failedStep })
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
      trackEvent('ollama_setup_failed', { failed_step: failedStep })
    })

    return () => {
      unsubTranscription()
      unsubSegmentation()
      unsubWhisper()
      unsubOllama()
    }
  }, [])

  // Auto-start recording when user clicks "Start AI Notes" from floating notification
  useEffect(() => {
    if (isRecording) {
      autoRecordStartInFlight.current = false
    }
  }, [isRecording])

  useEffect(() => {
    const unsub = window.electronAPI.on('detection:auto-record', ({ providerId, hasCalendarEvent }) => {
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
            hasCalendarEvent,
          },
        })
        try {
          const sources = await fetchSources()
          const selection = chooseAutoRecordSource(
            sources,
            selectionContext,
            getSavedSourcePreference(selectionContext),
          )

          if (selection.source && selection.confidence === 'high') {
            await handleStart(selection.source.id, selection.source.name, selectionContext)
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
              selectionConfidence: selection.confidence,
            },
          })
          trackEvent('meeting_window_detection_failed', {
            trigger: 'auto_record',
            has_calendar_event: hasCalendarEvent,
            provider_hint: selection.providerHint ?? 'unknown',
            window_count: selection.windowCount,
            browser_window_count: selection.browserWindowCount,
            meeting_window_count: selection.meetingWindowCount,
            selection_method: selection.method,
            selection_confidence: selection.confidence,
          })

          recordDiagnosticAction({
            category: 'recording',
            action: 'manual_source_selection_required',
            details: {
              trigger: 'auto_record',
              hasSuggestion: selection.source !== null,
            },
          })
          trackEvent('recording_manual_source_selection_required', {
            trigger: 'auto_record',
            has_suggestion: selection.source !== null,
            provider_hint: selection.providerHint ?? 'unknown',
          })
          window.electronAPI.send('detection:request-picker', selection.source?.id ?? null)
        } catch (err) {
          autoRecordStartInFlight.current = false
          console.error('Auto-record failed:', err)
          return
        }
        autoRecordStartInFlight.current = false
      })()
    })
    return unsub
  }, [events, isRecording, fetchSources, handleStart])

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
            meetingWindowVisible: payload.meetingWindowVisible,
          },
        })
        trackEvent('recording_auto_stopped', {
          reason: payload.reason,
          duration_seconds: elapsedSeconds,
          source_type: payload.sourceType,
          provider_detected: payload.providerDetected,
          meeting_window_visible: payload.meetingWindowVisible,
          window_missing_polls: payload.windowMissingPolls,
          provider_missing_polls: payload.providerMissingPolls,
          mic_silent_polls: payload.micSilentPolls,
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
          recoveredSignals: payload.recoveredSignals.join(','),
        },
      })
      trackEvent('recording_auto_stop_cancelled', {
        reason: payload.reason,
        source_type: payload.sourceType,
        provider_detected: payload.providerDetected,
        meeting_window_visible: payload.meetingWindowVisible,
        window_missing_polls: payload.windowMissingPolls,
        provider_missing_polls: payload.providerMissingPolls,
        mic_silent_polls: payload.micSilentPolls,
        recovered_signals: payload.recoveredSignals.join(','),
      })
    })
    return () => {
      unsub()
      unsubCancelled()
    }
  }, [elapsedSeconds, handleStop, isRecording])

  useEffect(() => {
    const unsub = window.electronAPI.on('detection:source-selected', ({ sourceId, sourceName }) => {
      void (async () => {
        if (isRecording) return
        try {
          await handleStart(sourceId, sourceName)
        } catch (err) {
          console.error('Picker source selection failed:', err)
        }
      })()
    })
    return unsub
  }, [handleStart, isRecording])

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
          <RecordingPickerOverlay onStartRecording={handleStart} />
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
