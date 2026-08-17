import { useSupportEmail } from '../../hooks/useSupportEmail'

const STATUS_ID = 'onboarding-support-email-status'

export function OnboardingSupportLink() {
  const { available, result, requestPending, copyStatus, openSupportEmail, copySupportEmail } =
    useSupportEmail('onboarding')

  if (available !== true) return null

  return (
    <div className="flex min-h-6 flex-col items-center gap-1 text-center text-[12px] text-ink-faint">
      <div className="flex items-center gap-1.5">
        <span>Need help?</span>
        <button
          type="button"
          onClick={openSupportEmail}
          disabled={requestPending || result !== null}
          aria-describedby={result ? STATUS_ID : undefined}
          className="rounded-sm font-medium text-sage-dark underline decoration-sage/40 underline-offset-2 transition-colors hover:text-sage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-default disabled:no-underline disabled:opacity-60"
        >
          {requestPending ? 'Opening email…' : 'Email Us'}
        </button>
      </div>

      <div id={STATUS_ID} aria-live="polite" aria-atomic="true" className="min-h-4 leading-4">
        {result?.status === 'copy-required' ? (
          <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
            <span>Mail app didn’t open.</span>
            <span className="select-text break-all text-ink-muted">{result.address}</span>
            <button
              type="button"
              onClick={copySupportEmail}
              disabled={copyStatus === 'copying' || copyStatus === 'copied'}
              className="rounded-sm font-medium text-sage-dark underline decoration-sage/40 underline-offset-2 transition-colors hover:text-sage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-default disabled:no-underline disabled:opacity-60"
            >
              {copyStatus === 'copying'
                ? 'Copying…'
                : copyStatus === 'copied'
                  ? 'Email address copied'
                  : copyStatus === 'failed'
                    ? 'Try copying again'
                    : 'Copy email address'}
            </button>
            {copyStatus === 'failed' ? <span>Couldn’t copy the address.</span> : null}
          </div>
        ) : null}

        {result?.status === 'unavailable' ? <p>Email isn’t available right now.</p> : null}
      </div>
    </div>
  )
}
