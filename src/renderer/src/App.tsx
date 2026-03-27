import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
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

export default function App() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)
  const { isRecording, sourceName, elapsedSeconds, handleStop, fetchSources, handleStart } = useRecording()

  useEffect(() => {
    // Initialize analytics early (stays opted-out until consent is restored/given)
    initAnalytics()

    window.electronAPI.invoke('prefs:get-onboarding-complete').then(setOnboardingDone)

    // Restore analytics consent for returning users
    window.electronAPI.invoke('prefs:get-analytics-consent').then((consent) => {
      if (consent === true) {
        restoreAnalyticsConsent(true)
        trackEvent('app_opened')
      }
    })
  }, [])

  // Auto-start recording when user clicks "Start AI Notes" from floating notification
  useEffect(() => {
    const unsub = window.electronAPI.on('detection:auto-record', async () => {
      if (isRecording) return
      try {
        const sources = await fetchSources()
        // Try meeting window first, fall back to first screen capture
        const detected = detectMeetingWindow(sources)
          ?? sources.find((s) => s.id.startsWith('screen:'))
          ?? sources[0]
        if (detected) {
          await handleStart(detected.id, detected.name)
        }
      } catch (err) {
        console.error('Auto-record failed:', err)
      }
    })
    return unsub
  }, [isRecording, fetchSources, handleStart])

  // Auto-stop recording when meeting ends (mic goes silent for 30s)
  useEffect(() => {
    const unsub = window.electronAPI.on('detection:auto-stop', async () => {
      if (!isRecording) return
      console.log('Auto-stopping recording — meeting ended')
      trackEvent('recording_auto_stopped')
      await handleStop()
    })
    return unsub
  }, [isRecording, handleStop])

  if (onboardingDone === null) return null

  if (!onboardingDone) {
    return <Onboarding onComplete={() => setOnboardingDone(true)} />
  }

  return (
    <HashRouter>
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
