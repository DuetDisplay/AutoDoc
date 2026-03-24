import { PageHeader } from '../components/PageHeader'

export function AskAI() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Ask AI" />
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-ink-muted text-[13px]">
          Ask questions about your meetings
        </p>
      </div>
      <div className="p-6 border-t border-border">
        <input
          type="text"
          placeholder="Ask a question about your meetings..."
          className="w-full px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-ink-muted transition-colors"
        />
      </div>
    </div>
  )
}
