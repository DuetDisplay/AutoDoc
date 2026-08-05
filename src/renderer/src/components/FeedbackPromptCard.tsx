import { useId, type ReactElement, type ReactNode } from 'react'
import type { OpenSupportEmailResult } from '../../../shared/types'

export type FeedbackPromptAppearance = 'initial' | 'reminder'
export type FeedbackPromptCopyStatus = 'idle' | 'copied' | 'failed'

export interface FeedbackPromptCardProps {
  appearance: FeedbackPromptAppearance
  pending: boolean
  supportResult: OpenSupportEmailResult | null
  copyStatus: FeedbackPromptCopyStatus
  onShare: () => void
  onCopy: (address: string) => void
  onLater: () => void
  onNever: () => void
  onDismiss: () => void
}

function WaveformMark(): ReactElement {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-sage/20 bg-bg-card/70 text-sage-dark">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        className="size-5"
        fill="currentColor"
      >
        <rect x="3" y="9" width="2.5" height="6" rx="1.25" />
        <rect x="8.25" y="5" width="2.5" height="14" rx="1.25" />
        <rect x="13.5" y="7" width="2.5" height="10" rx="1.25" />
        <rect x="18.75" y="10" width="2.5" height="4" rx="1.25" />
      </svg>
    </div>
  )
}

function SupportStatus({
  supportResult,
  copyStatus,
  pending,
  onCopy
}: Pick<
  FeedbackPromptCardProps,
  'supportResult' | 'copyStatus' | 'pending' | 'onCopy'
>): ReactNode {
  if (!supportResult) return null

  if (supportResult.status === 'opened') {
    return <p>Draft opened in your email app.</p>
  }

  if (supportResult.status === 'unavailable') {
    return <p>Email isn’t configured in this build.</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <p>Mail app didn’t open.</p>
      <span className="break-all font-medium text-ink-muted select-text">
        {supportResult.address}
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() => onCopy(supportResult.address)}
        className="rounded-sm font-semibold text-sage-dark transition-colors hover:text-sage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Copy email address
      </button>
      {copyStatus === 'copied' ? <p className="basis-full">Email address copied.</p> : null}
      {copyStatus === 'failed' ? (
        <p className="basis-full">Couldn’t copy. Select the address above.</p>
      ) : null}
    </div>
  )
}

const actionClassName =
  'rounded-lg px-3 py-1.5 text-[11.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50'

export function FeedbackPromptCard({
  appearance,
  pending,
  supportResult,
  copyStatus,
  onShare,
  onCopy,
  onLater,
  onNever,
  onDismiss
}: FeedbackPromptCardProps): ReactElement {
  const headingId = useId()
  const bodyId = useId()

  return (
    <section
      aria-labelledby={headingId}
      aria-describedby={bodyId}
      aria-busy={pending}
      className="relative w-full overflow-hidden rounded-xl border border-sage/25 bg-sage-light/60"
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-sage" />
      <div className="flex items-start gap-3 py-3.5 pr-4 pl-5">
        <WaveformMark />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[13px] font-semibold tracking-[-0.01em] text-ink">
            How’s AutoDoc working for you?
          </h2>
          <p id={bodyId} className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Tell us what’s working, what’s missing, or what AutoDoc could do better.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={onShare}
              className={`${actionClassName} bg-sage text-white hover:bg-sage-dark`}
            >
              Share feedback
            </button>
            {appearance === 'initial' ? (
              <button
                type="button"
                disabled={pending}
                onClick={onLater}
                className={`${actionClassName} text-sage-dark hover:bg-bg-card/60`}
              >
                Maybe later
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={onDismiss}
                className={`${actionClassName} text-sage-dark hover:bg-bg-card/60`}
              >
                Dismiss
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={onNever}
              className={`${actionClassName} text-ink-muted hover:bg-bg-card/60 hover:text-ink`}
            >
              Don’t ask again
            </button>
          </div>

          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mt-2 min-h-4 text-[10.5px] leading-4 text-ink-faint"
          >
            <SupportStatus
              supportResult={supportResult}
              copyStatus={copyStatus}
              pending={pending}
              onCopy={onCopy}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
