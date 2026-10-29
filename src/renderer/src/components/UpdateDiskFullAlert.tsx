import { useT } from '../services/i18n'

/** Alert shown when downloading an update failed because the disk is full. */
export function UpdateDiskFullAlert({
  variant,
  onTryAgain,
  onDismiss
}: {
  variant: 'banner' | 'card'
  onTryAgain: () => void
  onDismiss?: () => void
}) {
  const t = useT()
  const banner = variant === 'banner'

  return (
    <div
      role="alert"
      className={
        banner
          ? 'app-banner mx-6 mt-2 mb-0 rounded-xl border border-clay/30 bg-clay-light px-4 py-3 shadow-sm animate-[slideDown_300ms_ease] min-w-0'
          : 'mb-3 rounded-xl border border-clay/30 bg-clay-light px-4 py-3'
      }
    >
      <div className={banner ? 'app-banner-row' : 'flex items-start gap-3'}>
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
        <div className={banner ? 'app-banner-copy' : 'min-w-0 flex-1'}>
          <p className="text-[12px] font-semibold text-ink">
            {t('ui.notEnoughSpaceToInstallTheUpdate')}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
            {t('ui.yourComputerIsAlmostOutOfDiskSpaceFreeUpSomeSpaceThenTryAgain')}
          </p>
          {!banner && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <TryAgainButton onClick={onTryAgain} label={t('ui.tryAgain')} />
            </div>
          )}
        </div>
        {banner && (
          <div className="app-banner-actions">
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="i18n-btn text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
              >
                {t('ui.notNow')}
              </button>
            )}
            <TryAgainButton onClick={onTryAgain} label={t('ui.tryAgain')} />
          </div>
        )}
      </div>
    </div>
  )
}

function TryAgainButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="i18n-btn rounded-lg bg-sage-light px-3 py-1.5 text-[11.5px] font-semibold text-sage-dark transition-colors hover:bg-bg-card"
    >
      {label}
    </button>
  )
}
