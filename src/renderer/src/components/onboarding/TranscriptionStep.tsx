import { useEffect, useRef, useState } from 'react'

const phaseLabels: Record<string, (percent: number) => string> = {
  checking: () => 'Checking transcription setup...',
  'downloading-whisper': (p) => `Downloading transcription engine... ${p}%`,
  'downloading-ffmpeg': (p) => `Installing audio tools... ${p}%`,
  'downloading-model': (p) => `Downloading speech model... ${p}%`,
  'preparing-speaker-runtime': (p) => `Preparing speaker identification runtime... ${p}%`,
  'installing-speaker-id': (p) => `Installing speaker identification... ${p}%`,
  'downloading-speaker-model': (p) => `Downloading speaker identification model... ${p}%`,
}

export function TranscriptionStep({ onNext }: { onNext: () => void }) {
  const [phase, setPhase] = useState<string>('checking')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showSkip, setShowSkip] = useState(false)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const markReady = () => {
    setPhase('ready')
    setPercent(100)
    setError(null)
    if (!advanceTimer.current) {
      advanceTimer.current = setTimeout(onNext, 1500)
    }
  }

  useEffect(() => {
    window.electronAPI.invoke('whisper:get-setup-status').then(async (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') markReady()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
      if (status.phase === 'checking') {
        await window.electronAPI.invoke('whisper:retry-setup')
      }
    })

    const unsub = window.electronAPI.on('whisper:setup-progress', (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') markReady()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    return () => {
      unsub()
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    }
  }, [onNext])

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), 1500)
    return () => clearTimeout(timer)
  }, [])

  if (phase === 'ready') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-sage-light flex items-center justify-center mx-auto mb-5">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4A6B4E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Transcription Ready</h2>
        <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
          Your local transcription engine is installed and ready to go.
        </p>
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
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Setting Up Transcription</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc uses a local speech engine and local speaker identification to process meetings on-device. This downloads once and runs entirely on your machine.
      </p>

      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">
        {phaseLabels[phase]?.(percent) ?? (error ? `Setup failed: ${error}` : 'Preparing...')}
      </div>

      {error && (
        <div className="max-w-[360px] mx-auto mb-5 rounded-[14px] border border-border bg-mist-light/60 p-4 text-left">
          <h3 className="text-[14px] font-semibold text-ink mb-2">We hit a setup issue</h3>
          <p className="text-[13px] text-ink-muted leading-relaxed">
            AutoDoc could not finish installing transcription just yet. Retry to resume the managed setup.
          </p>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={async () => {
              setError(null)
              setPhase('checking')
              setPercent(0)
              await window.electronAPI.invoke('whisper:retry-setup')
            }}
            className="px-6 py-2.5 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {showSkip && !error && (
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
