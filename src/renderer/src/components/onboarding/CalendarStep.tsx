import { useState, useEffect } from 'react'

export function CalendarStep({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    window.electronAPI.invoke('calendar:get-accounts').then((accounts) => {
      if (accounts.length > 0) onNext()
    })
  }, [onNext])

  const handleConnect = async (provider: 'google' | 'microsoft') => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect', provider)
      setConnected(true)
    } catch {
      // OAuth cancelled or failed
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-mist-light text-ink-muted rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        OPTIONAL
      </span>
      <div className="w-16 h-16 rounded-2xl bg-sage-light flex items-center justify-center text-[28px] mx-auto mb-5">
        📅
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Connect Calendar</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        Connect your calendar to automatically name recordings after meetings and suggest speaker names from attendee lists.
      </p>

      {connected ? (
        <button
          onClick={onNext}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : (
        <>
          <div className="flex flex-col gap-2 items-center">
            <button
              onClick={() => handleConnect('google')}
              disabled={connecting}
              className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              {connecting ? 'Connecting...' : 'Connect Google Calendar'}
            </button>
            <button
              onClick={() => handleConnect('microsoft')}
              disabled={connecting}
              className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              {connecting ? 'Connecting...' : 'Connect Microsoft Outlook'}
            </button>
          </div>
          <button
            onClick={onNext}
            className="block mx-auto mt-3 text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
          >
            Skip for now
          </button>
        </>
      )}
    </div>
  )
}
