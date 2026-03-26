import { useState, useEffect } from 'react'

export function OllamaStep({ onNext }: { onNext: () => void }) {
  const [phase, setPhase] = useState<string>('downloading')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [showSkip, setShowSkip] = useState(false)

  useEffect(() => {
    // Check initial status
    window.electronAPI.invoke('ollama:get-setup-status').then((status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') onNext()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    // Listen for progress updates
    const unsub = window.electronAPI.on('ollama:setup-progress', (status) => {
      setPhase(status.phase)
      setPercent(status.percent)
      if (status.phase === 'ready') onNext()
      if (status.phase === 'error') setError(status.error ?? 'Unknown error')
    })

    return unsub
  }, [onNext])

  useEffect(() => {
    const timer = setTimeout(() => setShowSkip(true), 5000)
    return () => clearTimeout(timer)
  }, [])

  const statusLabel = phase === 'downloading'
    ? `Downloading AI model... ${percent}%`
    : phase === 'pulling'
      ? `Installing model... ${percent}%`
      : error
        ? `Setup failed: ${error}`
        : 'Ready'

  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-dusk-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🤖
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Setting Up AI</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        AutoDoc uses a local AI model to analyze your transcripts and generate smart notes. This downloads once and runs entirely on your machine.
      </p>

      {/* Progress bar */}
      <div className="w-60 h-1 bg-border rounded-full mx-auto mb-2 overflow-hidden">
        <div
          className="h-full bg-sage rounded-full transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-[12px] text-ink-faint mb-5">{statusLabel}</div>

      {error && (
        <button
          onClick={async () => {
            setError(null)
            setPhase('downloading')
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
          Continue — this will finish in the background
        </button>
      )}
    </div>
  )
}
