import { PageHeader } from '../components/PageHeader'

export function Upcoming() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Upcoming"
        subtitle={today}
        action={
          <button className="text-[11px] font-medium text-white bg-ink px-3 py-1.5 rounded-md hover:bg-ink-secondary transition-colors">
            + New meeting
          </button>
        }
      />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-ink-muted text-[13px]">
            Connect Google Calendar to see upcoming meetings
          </p>
          <button className="mt-4 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors">
            Connect Calendar
          </button>
        </div>
      </div>
    </div>
  )
}
