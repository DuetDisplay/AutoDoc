import { PageHeader } from '../components/PageHeader'

export function Search() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Search" />
      <div className="p-6">
        <input
          type="text"
          placeholder="Search across all meetings..."
          className="w-full px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink-muted transition-colors"
        />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-ink-muted text-[13px]">
          Search results will appear here
        </p>
      </div>
    </div>
  )
}
