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
              className="flex items-center justify-center gap-2.5 px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {connecting ? 'Connecting...' : 'Connect Google Calendar'}
            </button>
            <button
              onClick={() => handleConnect('microsoft')}
              disabled={connecting}
              className="flex items-center justify-center gap-2.5 px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors disabled:opacity-50 w-64"
            >
              <svg width="18" height="18" viewBox="0 0 23 23" fill="none">
                <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
                <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
                <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
                <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
              </svg>
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
