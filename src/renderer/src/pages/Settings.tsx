import { useState, useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { useCalendarStore } from '../stores/calendar'
import type { UpdateStatus } from '../../../preload/ipc.d'

export function Settings() {
  const { isConnected, isConnecting, setConnected, setConnecting, setEvents } = useCalendarStore()
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.electronAPI.invoke('app:get-version').then(setAppVersion)
    window.electronAPI.invoke('updater:get-status').then(setUpdateStatus)
    const unsub = window.electronAPI.on('updater:status', setUpdateStatus)
    return unsub
  }, [])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.electronAPI.invoke('calendar:connect')
      setConnected(true)
      const events = await window.electronAPI.invoke('calendar:get-events')
      setEvents(events)
    } catch (err) {
      console.error('Failed to connect calendar:', err)
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    await window.electronAPI.invoke('calendar:disconnect')
    setConnected(false)
    setEvents([])
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Settings" />
      <div className="p-6 flex flex-col gap-6">
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Google Calendar</h3>
          {isConnected ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-status-connected" />
                <span className="text-[12px] text-ink-muted">Connected</span>
              </div>
              <button
                onClick={handleDisconnect}
                className="text-[12px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
            >
              {isConnecting ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-ink mb-2">Auto-record</h3>
          <p className="text-[12px] text-ink-muted">Default: off</p>
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
