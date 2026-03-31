import { useState, useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { useCalendarStore } from '../stores/calendar'
import type { UpdateStatus } from '../../../preload/ipc.d'

export function Settings() {
  const { accounts, isConnecting, setAccounts, addAccount, removeAccount, setConnecting, setEvents } = useCalendarStore()
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.electronAPI.invoke('app:get-version').then(setAppVersion)
    window.electronAPI.invoke('updater:get-status').then(setUpdateStatus)
    const unsub = window.electronAPI.on('updater:status', setUpdateStatus)
    return unsub
  }, [])

  useEffect(() => {
    window.electronAPI.invoke('calendar:get-accounts').then(setAccounts)
  }, [setAccounts])

  const handleConnect = async (provider: 'google' | 'microsoft') => {
    setConnecting(true)
    try {
      const account = await window.electronAPI.invoke('calendar:connect', provider)
      addAccount(account)
      const events = await window.electronAPI.invoke('calendar:get-events')
      setEvents(events)
    } catch (err) {
      console.error('Failed to connect calendar:', err)
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async (accountId: string) => {
    await window.electronAPI.invoke('calendar:disconnect', accountId)
    removeAccount(accountId)
    const events = await window.electronAPI.invoke('calendar:get-events')
    setEvents(events)
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Settings" />
      <div className="p-6 flex flex-col gap-6">
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Calendars</h3>

          {accounts.length > 0 && (
            <div className="flex flex-col gap-2 mb-3">
              {accounts.map((account) => (
                <div key={account.id} className="flex items-center gap-3">
                  {account.provider === 'google' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
                      <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
                      <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
                      <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
                      <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
                    </svg>
                  )}
                  <span className="text-[12px] text-ink-muted">{account.email}</span>
                  <button
                    onClick={() => handleDisconnect(account.id)}
                    className="text-[12px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => handleConnect('google')}
              disabled={isConnecting}
              className="flex items-center gap-2 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {isConnecting ? 'Connecting...' : 'Add Google Calendar'}
            </button>
            <button
              onClick={() => handleConnect('microsoft')}
              disabled={isConnecting}
              className="flex items-center gap-2 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
                <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
                <rect x="12" y="1" width="10" height="10" fill="#7FBA00"/>
                <rect x="1" y="12" width="10" height="10" fill="#00A4EF"/>
                <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
              </svg>
              {isConnecting ? 'Connecting...' : 'Add Microsoft Outlook'}
            </button>
          </div>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Auto-record</h3>
          <p className="text-[12px] text-ink-muted">Default: off</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Whisper Model</h3>
          <p className="text-[12px] text-ink-muted">Windows defaults to distil-large-v3. macOS uses large-v3.</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Ollama Model</h3>
          <p className="text-[12px] text-ink-muted">llama3 (default)</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Storage Path</h3>
          <p className="text-[12px] text-ink-muted font-mono">~/AutoDoc/</p>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">About</h3>
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-ink-muted">
              AutoDoc v{appVersion}
            </span>
            {updateStatus.state === 'idle' && (
              <button
                onClick={() => window.electronAPI.invoke('updater:check')}
                className="text-[11px] font-medium text-sage hover:text-sage-dark transition-colors"
              >
                Check for updates
              </button>
            )}
            {updateStatus.state === 'checking' && (
              <span className="text-[11px] text-ink-faint animate-pulse">Checking...</span>
            )}
            {updateStatus.state === 'available' && (
              <span className="text-[11px] text-sage font-medium">
                v{updateStatus.version} downloading...
              </span>
            )}
            {updateStatus.state === 'downloading' && (
              <span className="text-[11px] text-sage font-medium">
                Downloading update... {updateStatus.percent}%
              </span>
            )}
            {updateStatus.state === 'downloaded' && (
              <button
                onClick={() => window.electronAPI.invoke('updater:install')}
                className="text-[11px] font-semibold text-white bg-sage px-3 py-1 rounded-lg hover:bg-sage-dark transition-colors"
              >
                Restart to update to v{updateStatus.version}
              </button>
            )}
            {updateStatus.state === 'error' && (
              <span className="text-[11px] text-clay">Update check failed</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
