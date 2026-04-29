import { useState, useEffect } from 'react'

export function OllamaStep({ onNext }: { onNext: () => void }) {
  const [phase, setPhase] = useState<string>('starting')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showSkip, setShowSkip] = useState(false)

  const markReady = () => {
    setPhase('ready')
    setPercent(100)
  }

  useEffect(() => {
    window.electronAPI.invoke('ollama:get-setup-status').then(async (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') markReady()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
      if (status.phase === 'starting' && status.percent === 0) {
        await window.electronAPI.invoke('ollama:retry-setup')
      }
    })

    const unsub = window.electronAPI.on('ollama:setup-progress', (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') markReady()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    return () => {
      unsub()
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
        <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">AI Model Ready</h2>
        <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
          Your local AI model is set up and ready to go.
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

  const statusLabel =
    phase === 'starting'
      ? 'Starting local AI engine...'
      : phase === 'downloading'
        ? `Downloading local AI engine... ${percent}%`
        : phase === 'pulling'
          ? `Downloading AI model... ${percent}%`
          : error
            ? `Setup failed: ${error}`
            : 'Preparing...'

  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-dusk-light flex items-center justify-center text-[28px] mx-auto mb-5">
        AI
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Setting Up AI</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc is downloading a one-time local AI setup so your transcripts can be analyzed on your
        machine.
      </p>

      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${phase === 'starting' ? 20 : percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">{statusLabel}</div>

      {error && (
        <button
          onClick={async () => {
            setError(null)
            setPhase('starting')
            setPercent(0)
            await window.electronAPI.invoke('ollama:retry-setup')
          }}
          className="px-6 py-2.5 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
        >
          Retry
        </button>
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
