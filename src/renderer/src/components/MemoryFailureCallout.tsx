import { memoryFailureDetails, type MemoryFailure } from '../../../shared/memory-failure'

export function MemoryFailureCallout({
  stage,
  failure,
  onRetry,
  onViewTranscript
}: {
  stage: 'transcription' | 'notes'
  failure: MemoryFailure
  onRetry: () => void
  onViewTranscript?: () => void
}) {
  const details = memoryFailureDetails(failure)
  return (
    <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-white/70 text-amber-700">
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M5.75 2.75h5.5l3 3v9.5a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2Z" />
            <path d="M11.25 2.75v3h3M9 8.5v3.25M9 14h.01" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-ink">Not enough available memory</h3>
          <p className="mt-1 text-[12px] text-ink-muted leading-relaxed">
            Your computer doesn’t have enough free RAM to{' '}
            {stage === 'transcription' ? 'finish transcription' : 'generate notes'}. Close other
            apps, then retry.
          </p>
          {details && <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">{details}</p>}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={onRetry}
              className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-sage/15 text-sage hover:bg-sage/25 transition-colors"
            >
              {stage === 'transcription' ? 'Retry transcription' : 'Retry notes'}
            </button>
            {onViewTranscript && (
              <button
                onClick={onViewTranscript}
                className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg border border-border text-ink-muted hover:text-ink hover:bg-bg-accent transition-colors"
              >
                View transcript
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
