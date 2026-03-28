interface ConnectCalendarProps {
  isConnecting: boolean
  onConnect: (provider: 'google' | 'microsoft') => void
}

export function ConnectCalendar({ isConnecting, onConnect }: ConnectCalendarProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center">
        <p className="text-ink-muted text-[13px] mb-4">
          Connect a calendar to see upcoming meetings
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onConnect('google')}
            disabled={isConnecting}
            className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect Google Calendar'}
          </button>
          <button
            onClick={() => onConnect('microsoft')}
            disabled={isConnecting}
            className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect Microsoft Outlook'}
          </button>
        </div>
      </div>
    </div>
  )
}
