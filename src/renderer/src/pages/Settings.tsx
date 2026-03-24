import { PageHeader } from '../components/PageHeader'
import { useCalendarStore } from '../stores/calendar'

export function Settings() {
  const { isConnected, isConnecting, setConnected, setConnecting, setEvents } = useCalendarStore()

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
      </div>
    </div>
  )
}
