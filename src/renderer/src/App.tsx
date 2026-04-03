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
import { detectMeetingWindow } from './services/window-detection'
import { RecordingBanner } from './components/RecordingBanner'
import { MeetingDetectedBanner } from './components/MeetingDetectedBanner'
import { PermissionToast } from './components/PermissionToast'
import { Onboarding } from './pages/Onboarding'
import { initAnalytics, restoreAnalyticsConsent, trackEvent } from './services/analytics'
import { recordDiagnosticAction, setDiagnosticConsentEnabled } from './services/diagnostic-trail'
import { updateRendererSentryConsent } from './services/renderer-sentry'
import { useCalendarStore } from './stores/calendar'

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
  const { setAccounts, setEvents } = useCalendarStore()
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
    const unsub = window.electronAPI.on('detection:auto-record', () => {
      void (async () => {
        if (isRecording || autoRecordStartInFlight.current) return
        autoRecordStartInFlight.current = true
        recordDiagnosticAction({
          category: 'recording',
          action: 'auto_record_requested',
        })
        try {
          const sources = await fetchSources()
          // Try meeting window first, fall back to first screen capture
          const detected = detectMeetingWindow(sources)
            ?? sources.find((s) => s.id.startsWith('screen:'))
            ?? sources[0]
          if (detected) {
            await handleStart(detected.id, detected.name)
          } else {
            autoRecordStartInFlight.current = false
          }
        } catch (err) {
          autoRecordStartInFlight.current = false
          console.error('Auto-record failed:', err)
        }
      })()
    })
    return unsub
  }, [isRecording, fetchSources, handleStart])

  // Auto-stop recording when meeting ends (mic goes silent for 30s)
  useEffect(() => {
    const unsub = window.electronAPI.on('detection:auto-stop', ({ reason }) => {
      void (async () => {
        if (!isRecording) return
        console.log('Auto-stopping recording — meeting ended')
        recordDiagnosticAction({
          category: 'recording',
          action: 'auto_stop_triggered',
          details: { reason },
        })
        trackEvent('recording_auto_stopped', { reason, duration_seconds: elapsedSeconds })
        try {
          await handleStop()
        } catch (err) {
          console.error('Auto-stop failed:', err)
        }
      })()
    })
    return unsub
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
