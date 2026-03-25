import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useRecordingStore } from '../stores/recording'
import { ROUTES } from '../../../shared/constants'

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
      {/* Top padding to clear macOS traffic lights */}
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
        {ollamaConnected !== null && (
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
        )}

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
