import { PageHeader } from '../components/PageHeader'

export function Recordings() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Recordings" />
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-ink-muted text-[13px]">
          No recordings yet. Start a meeting to begin.
        </p>
      </div>
    </div>
  )
}
