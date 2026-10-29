import { useT } from '../services/i18n'

export function DiskFullCallout({
  stage,
  onRetry
}: {
  stage: 'transcription' | 'notes'
  onRetry: () => void
}) {
  const t = useT()

  return (
    <div role="alert" className="rounded-xl border border-clay/30 bg-clay-light px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-clay/30 bg-bg-card text-clay-dark">
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
          <p className="text-[12px] text-ink-muted leading-relaxed">
            {t('ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              onClick={onRetry}
              className="px-3 py-1.5 text-[11.5px] font-semibold rounded-lg bg-sage-light text-sage-dark hover:bg-bg-card transition-colors"
            >
              {stage === 'transcription' ? t('ui.retryTranscription') : t('ui.retryNotes')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
