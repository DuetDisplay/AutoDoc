import { NavLink } from 'react-router-dom'
import { useAppStore } from '../stores/app'
import { useRecordingStore } from '../stores/recording'
import { ROUTES } from '../../../shared/constants'

const navItems = [
  { to: ROUTES.upcoming, label: 'Upcoming' },
  { to: ROUTES.recordings, label: 'Recordings' },
  { to: ROUTES.search, label: 'Search' },
  { to: ROUTES.askAi, label: 'Ask AI' },
]

export function Sidebar() {
  const ollamaConnected = useAppStore((s) => s.ollamaConnected)
  const isRecording = useRecordingStore((s) => s.isRecording)
  const recordingSeconds = useRecordingStore((s) => s.elapsedSeconds)

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <aside className="w-[200px] bg-bg-sidebar border-r border-border flex flex-col p-5 shrink-0">
      <div className="text-[15px] font-bold text-ink tracking-[-0.03em]">
        AutoDoc
      </div>

      <nav className="mt-6 flex flex-col gap-0.5">
        {navItems.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
                isActive
                  ? 'bg-ink text-white'
                  : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        {isRecording && (
          <div className="flex items-center gap-2 px-2.5 py-2 bg-bg-accent rounded-lg">
            <div className="w-2 h-2 rounded-full bg-status-recording animate-pulse" />
            <span className="text-[11px] text-ink-muted">
              Recording · {formatTime(recordingSeconds)}
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 px-2.5 py-2.5 bg-bg-accent rounded-lg">
          <div
            className={`w-2 h-2 rounded-full ${
              ollamaConnected ? 'bg-status-connected' : 'bg-status-recording'
            }`}
          />
          <span className="text-[11px] text-ink-muted">
            Ollama {ollamaConnected ? 'connected' : 'disconnected'}
          </span>
        </div>

        <NavLink
          to={ROUTES.settings}
          className={({ isActive }) =>
            `px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors ${
              isActive
                ? 'bg-ink text-white'
                : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
            }`
          }
        >
          Settings
        </NavLink>
      </div>
    </aside>
  )
}
