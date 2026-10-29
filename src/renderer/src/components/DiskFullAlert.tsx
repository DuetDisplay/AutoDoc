/** Clay alert for disk-full failures, as an app-wide banner or an inline card. */
export function DiskFullAlert({
  variant,
  title,
  body,
  actionLabel,
  onAction,
  dismissLabel,
  onDismiss,
  className = ''
}: {
  variant: 'banner' | 'card'
  title: string
  body: string
  actionLabel: string
  onAction: () => void
  dismissLabel?: string
  onDismiss?: () => void
  className?: string
}) {
  const banner = variant === 'banner'
  const action = (
    <button
      type="button"
      onClick={onAction}
      className="i18n-btn rounded-lg bg-sage-light px-3 py-1.5 text-[11.5px] font-semibold text-sage-dark transition-colors hover:bg-bg-card"
    >
      {actionLabel}
    </button>
  )

  return (
    <div
      role="alert"
      className={`${
        banner
          ? 'app-banner mx-6 mt-2 mb-0 rounded-xl border border-clay/30 bg-clay-light px-4 py-3 shadow-sm animate-[slideDown_300ms_ease] min-w-0'
          : 'mb-3 rounded-xl border border-clay/30 bg-clay-light px-4 py-3'
      } ${className}`.trim()}
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
        <div className={banner ? 'app-banner-copy' : 'min-w-0 flex-1 text-left'}>
          <p className="text-[12px] font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
          {!banner && <div className="mt-2.5 flex flex-wrap items-center gap-2">{action}</div>}
        </div>
        {banner && (
          <div className="app-banner-actions">
            {onDismiss && dismissLabel && (
              <button
                type="button"
                onClick={onDismiss}
                className="i18n-btn text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
              >
                {dismissLabel}
              </button>
            )}
            {action}
          </div>
        )}
      </div>
    </div>
  )
}
