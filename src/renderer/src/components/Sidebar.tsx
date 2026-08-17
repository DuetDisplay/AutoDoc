import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useRecordingStore } from '../stores/recording'
import { ROUTES } from '../../../shared/constants'
import type {
  OllamaSetupStatus,
  OpenSupportEmailResult,
  WhisperSetupStatus
} from '../../../shared/types'
import { trackEvent } from '../services/analytics'
import { getOllamaSetupLabel, getWhisperSetupLabel } from '../services/setup-status-labels'

const navItems = [
  { to: ROUTES.upcoming, label: 'Upcoming' },
  { to: ROUTES.recordings, label: 'AI Notes' },
  { to: ROUTES.search, label: 'Search' },
  { to: ROUTES.askAi, label: 'Ask AI' }
]

const SUPPORT_SURFACE = 'sidebar' as const

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
  const [supportAvailable, setSupportAvailable] = useState<boolean | null>(null)
  const [supportResult, setSupportResult] = useState<OpenSupportEmailResult | null>(null)
  const [supportRequestPending, setSupportRequestPending] = useState(false)
  const [supportCopyStatus, setSupportCopyStatus] = useState<
    'idle' | 'copying' | 'copied' | 'failed'
  >('idle')
  const supportRequestPendingRef = useRef(false)

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
    const refreshWhisperStatus = () => {
      window.electronAPI.invoke('whisper:get-setup-status').then((status) => {
        setWhisperPhase(status.phase)
        setWhisperPercent(status.percent)
      })
    }

    refreshWhisperStatus()
    const startupRefreshTimeout = window.setTimeout(refreshWhisperStatus, 1500)

    const unsub = window.electronAPI.on('whisper:setup-progress', (status) => {
      setWhisperPhase(status.phase)
      setWhisperPercent(status.percent)
    })

    return () => {
      window.clearTimeout(startupRefreshTimeout)
      unsub()
    }
  }, [])

  useEffect(() => {
    window.electronAPI
      .invoke('support:get-availability')
      .then(setSupportAvailable)
      .catch(() => setSupportAvailable(false))
  }, [])

  useEffect(() => {
    const check = () => {
      window.electronAPI.invoke('ollama:check-status').then((connected) => {
        setOllamaConnected(connected)
        if (connected) {
          setSetupPhase('ready')
          setSetupPercent(100)
        }
      })
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

  const whisperStatus =
    whisperPhase == null
      ? null
      : ({ phase: whisperPhase, percent: whisperPercent } as WhisperSetupStatus)
  const ollamaStatus =
    setupPhase == null ? null : ({ phase: setupPhase, percent: setupPercent } as OllamaSetupStatus)
  const whisperLabel = getWhisperSetupLabel(whisperStatus)
  const ollamaLabel = getOllamaSetupLabel(ollamaStatus)
  const showOllamaSetupProgress =
    setupPhase === 'downloading' ||
    setupPhase === 'pulling' ||
    (setupPhase === 'starting' && ollamaConnected !== true)

  const openSupportEmail = async (): Promise<void> => {
    if (supportRequestPendingRef.current || supportAvailable !== true) return

    supportRequestPendingRef.current = true
    setSupportRequestPending(true)
    setSupportResult(null)
    setSupportCopyStatus('idle')
    trackEvent('support_email_requested', { surface: SUPPORT_SURFACE })
    try {
      const result = await window.electronAPI.invoke('support:open-email', SUPPORT_SURFACE)
      setSupportResult(result.status === 'opened' ? null : result)
      trackEvent('support_email_outcome', {
        surface: SUPPORT_SURFACE,
        outcome:
          result.status === 'opened'
            ? 'draft_opened'
            : result.status === 'copy-required'
              ? 'copy_required'
              : 'unavailable'
      })
      if (result.status === 'unavailable') {
        setSupportAvailable(false)
      }
    } catch {
      setSupportResult({ status: 'unavailable' })
      setSupportAvailable(false)
      trackEvent('support_email_outcome', {
        surface: SUPPORT_SURFACE,
        outcome: 'unavailable'
      })
    } finally {
      supportRequestPendingRef.current = false
      setSupportRequestPending(false)
    }
  }

  const copySupportEmail = async (): Promise<void> => {
    if (supportCopyStatus === 'copying') return

    setSupportCopyStatus('copying')
    try {
      const result = await window.electronAPI.invoke('support:copy-email', SUPPORT_SURFACE)
      if (result.status === 'copied') {
        setSupportCopyStatus('copied')
        trackEvent('support_email_outcome', {
          surface: SUPPORT_SURFACE,
          outcome: 'address_copied'
        })
      } else {
        setSupportCopyStatus('failed')
        if (result.status === 'unavailable') setSupportAvailable(false)
        trackEvent('support_email_outcome', {
          surface: SUPPORT_SURFACE,
          outcome: result.status === 'copy-failed' ? 'copy_failed' : 'unavailable'
        })
      }
    } catch {
      setSupportCopyStatus('failed')
      trackEvent('support_email_outcome', {
        surface: SUPPORT_SURFACE,
        outcome: 'copy_failed'
      })
    }
  }

  return (
    <aside className="w-[200px] bg-bg-sidebar border-r border-border flex flex-col shrink-0">
      <div className="h-[52px] shrink-0" />
      <div className="flex flex-col flex-1 px-5 pb-5">
        <div className="flex items-center gap-2">
          <WaveformIcon className="w-6 h-6" />
          <span className="font-serif text-[20px] text-ink tracking-[-0.02em]">AutoDoc</span>
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
          whisperPhase === 'downloading-model' ||
          whisperPhase === 'preparing-speaker-runtime' ||
          whisperPhase === 'installing-speaker-id' ||
          whisperPhase === 'downloading-speaker-model' ? (
            <div className="px-2.5 py-2 flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-faint">{whisperLabel}</span>
              <div className="w-full h-1 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-sage rounded-full transition-all duration-300"
                  style={{ width: `${whisperPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          {showOllamaSetupProgress ? (
            <div className="px-2.5 py-2 flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-faint">{ollamaLabel}</span>
              <div className="w-full h-1 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-sage rounded-full transition-all duration-300"
                  style={{ width: `${setupPhase === 'starting' ? 20 : setupPercent}%` }}
                />
              </div>
            </div>
          ) : ollamaConnected !== null ? (
            <div className="flex items-center gap-2 px-2.5 py-2">
              <div className={`w-2 h-2 rounded-full ${ollamaConnected ? 'bg-sage' : 'bg-clay'}`} />
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
                isActive ? 'bg-sage text-white' : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
              }`
            }
          >
            Settings
          </NavLink>

          <button
            type="button"
            onClick={openSupportEmail}
            disabled={supportAvailable !== true || supportRequestPending}
            aria-describedby={supportAvailable === false ? 'support-email-unavailable' : undefined}
            className="w-full px-2.5 py-2 rounded-lg text-left text-[12.5px] font-medium text-ink-muted hover:text-ink hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
          >
            {supportRequestPending ? 'Opening email…' : 'Email Us'}
          </button>

          <div aria-live="polite" className="px-2.5 text-[10.5px] leading-4 text-ink-faint">
            {supportResult?.status === 'copy-required' ? (
              <div className="flex flex-col items-start gap-1">
                <p>Mail app didn’t open.</p>
                <span className="break-all select-text text-ink-muted">
                  {supportResult.address}
                </span>
                <button
                  type="button"
                  onClick={copySupportEmail}
                  disabled={supportCopyStatus === 'copying'}
                  className="font-semibold text-sage-dark hover:text-sage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 rounded-sm transition-colors disabled:cursor-wait disabled:opacity-60"
                >
                  {supportCopyStatus === 'copying' ? 'Copying…' : 'Copy email address'}
                </button>
                {supportCopyStatus === 'copied' ? <p>Email address copied.</p> : null}
                {supportCopyStatus === 'failed' ? (
                  <p>Couldn’t copy. Select the address above.</p>
                ) : null}
              </div>
            ) : supportResult?.status === 'unavailable' || supportAvailable === false ? (
              <p id="support-email-unavailable">Email isn’t configured in this build.</p>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
