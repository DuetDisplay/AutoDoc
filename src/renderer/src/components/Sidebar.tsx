import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useRecordingStore } from '../stores/recording'
import { ROUTES } from '../../../shared/constants'
import { trackEvent } from '../services/analytics'

const navItems = [
  { to: ROUTES.upcoming, label: 'Upcoming' },
  { to: ROUTES.recordings, label: 'AI Notes' },
  { to: ROUTES.search, label: 'Search' },
  { to: ROUTES.askAi, label: 'Ask AI' },
]

function WaveformIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className}>
      <rect x="6" y="14" width="4" height="12" rx="2" fill="#7A9E7E" />
      <rect x="14" y="8" width="4" height="24" rx="2" fill="#7A9E7E" />
      <rect x="22" y="11" width="4" height="18" rx="2" fill="#7A9E7E" />
      <rect x="30" y="16" width="4" height="8" rx="2" fill="#7A9E7E" />
    </svg>
  )
}

export function Sidebar() {
  const isRecording = useRecordingStore((s) => s.isRecording)
  const recordingSeconds = useRecordingStore((s) => s.elapsedSeconds)
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null)
  const [setupPhase, setSetupPhase] = useState<string | null>(null)
  const [setupPercent, setSetupPercent] = useState(0)
  const [whisperPhase, setWhisperPhase] = useState<string | null>(null)
  const [whisperPercent, setWhisperPercent] = useState(0)

  useEffect(() => {
    window.electronAPI.invoke('ollama:get-setup-status').then((status) => {
      setSetupPhase(status.phase)
      setSetupPercent(status.percent)
      if (status.phase === 'ready') setOllamaConnected(true)
    })

    const unsub = window.electronAPI.on('ollama:setup-progress', (status) => {
      setSetupPhase(status.phase)
      setSetupPercent(status.percent)
      if (status.phase === 'ready') setOllamaConnected(true)
    })

    return unsub
  }, [])

  useEffect(() => {
    window.electronAPI.invoke('whisper:get-setup-status').then((status) => {
      setWhisperPhase(status.phase)
      setWhisperPercent(status.percent)
    })

    const unsub = window.electronAPI.on('whisper:setup-progress', (status) => {
      setWhisperPhase(status.phase)
      setWhisperPercent(status.percent)
    })

    return unsub
  }, [])

  useEffect(() => {
    const check = () => {
      window.electronAPI.invoke('ollama:check-status').then(setOllamaConnected)
    }
    check()
    const interval = setInterval(check, 10_000)
    return () => clearInterval(interval)
  }, [])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <aside className="w-[200px] bg-bg-sidebar border-r border-border flex flex-col shrink-0">
      <div className="h-[52px] shrink-0" />
      <div className="flex flex-col flex-1 px-5 pb-5">
        <div className="flex items-center gap-2">
          <WaveformIcon className="w-6 h-6" />
          <span className="font-serif text-[20px] text-ink tracking-[-0.02em]">
            AutoDoc
          </span>
        </div>

        <nav className="mt-6 flex flex-col gap-0.5">
          {navItems.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
                  isActive
                    ? 'bg-sage text-white'
                    : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2">
          {whisperPhase === 'downloading-whisper' ||
          whisperPhase === 'downloading-ffmpeg' ||
          whisperPhase === 'downloading-model' ? (
            <div className="px-2.5 py-2 flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-faint">
                {whisperPhase === 'downloading-whisper'
                  ? `Downloading transcription engine... ${whisperPercent}%`
                  : whisperPhase === 'downloading-ffmpeg'
                    ? `Downloading audio tools... ${whisperPercent}%`
                    : `Downloading speech model... ${whisperPercent}%`}
              </span>
              <div className="w-full h-1 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-sage rounded-full transition-all duration-300"
                  style={{ width: `${whisperPercent}%` }}
                />
              </div>
            </div>
          ) : whisperPhase === 'checking' ? (
            <div className="px-2.5 py-2">
              <span className="text-[11px] text-ink-faint">
                Checking transcription engine...
              </span>
            </div>
          ) : null}

          {(setupPhase === 'starting' || setupPhase === 'downloading' || setupPhase === 'pulling') && setupPhase !== null ? (
            <div className="px-2.5 py-2 flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-faint">
                {setupPhase === 'starting'
                  ? 'Starting local AI engine...'
                  : setupPhase === 'downloading'
                    ? `Downloading AI model... ${setupPercent}%`
                    : `Installing AI model... ${setupPercent}%`}
              </span>
              <div className="w-full h-1 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-sage rounded-full transition-all duration-300"
                  style={{ width: `${setupPhase === 'starting' ? 20 : setupPercent}%` }}
                />
              </div>
            </div>
          ) : ollamaConnected !== null ? (
            <div className="flex items-center gap-2 px-2.5 py-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  ollamaConnected ? 'bg-sage' : 'bg-clay'
                }`}
              />
              <span className="text-[11px] text-ink-faint">
                Ollama {ollamaConnected ? 'connected' : 'disconnected'}
              </span>
            </div>
          ) : null}

          {isRecording && (
            <div className="flex items-center gap-2 px-2.5 py-2 bg-clay-light rounded-lg">
              <div className="w-2 h-2 rounded-full bg-clay animate-pulse" />
              <span className="text-[11px] text-ink-muted">
                Recording · {formatTime(recordingSeconds)}
              </span>
            </div>
          )}

          <NavLink
            to={ROUTES.settings}
            onClick={() => trackEvent('navigation_clicked', { page: 'settings' })}
            className={({ isActive }) =>
              `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
                isActive
                  ? 'bg-sage text-white'
                  : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
              }`
            }
          >
            Settings
          </NavLink>
        </div>
      </div>
    </aside>
  )
}
