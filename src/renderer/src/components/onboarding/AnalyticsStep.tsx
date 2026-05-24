import { useState } from 'react'

interface Props {
  diagnosticLogUploadConsented: boolean
  onDiagnosticLogUploadConsentedChange: (enabled: boolean) => void
  onNext: (consented: boolean, diagnosticLogUploadConsented: boolean) => void
}

export function AnalyticsStep({
  diagnosticLogUploadConsented,
  onDiagnosticLogUploadConsentedChange,
  onNext
}: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-full bg-mist-light flex items-center justify-center mx-auto mb-5">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5B7B8A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
      </div>

      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
        Help Improve AutoDoc
      </h2>

      <p className="text-[14px] text-ink-muted leading-relaxed mb-4">
        Share anonymous usage data so we can understand which features matter most and fix crashes faster.
        Meeting content stays local. If you choose, you can also attach technical app logs to error reports.
      </p>

      {/* What we track disclosure */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[12px] font-medium text-ink-faint hover:text-ink-muted transition-colors mb-4 flex items-center gap-1 mx-auto"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        What exactly do we track?
      </button>

      {expanded && (
        <div className="text-left bg-bg-accent rounded-lg p-4 mb-4 text-[12px] text-ink-muted leading-relaxed">
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span><strong className="text-ink">Feature usage</strong> — which screens you visit, buttons you click</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span><strong className="text-ink">Onboarding</strong> — which steps you complete or skip</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span><strong className="text-ink">Crash reports</strong> — stack traces when something goes wrong</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span><strong className="text-ink">Optional diagnostic logs</strong> — technical app logs only if you explicitly allow them</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span><strong className="text-ink">App version & OS</strong> — helps us prioritize platform fixes</span>
            </div>
            <div className="border-t border-border-subtle mt-3 pt-3 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-red-400 font-bold mt-[1px]">✗</span>
                <span>Meeting content, transcripts, or calendar data</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-400 font-bold mt-[1px]">✗</span>
                <span>Names, emails, or any personal information</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-red-400 font-bold mt-[1px]">✗</span>
                <span>Audio, video, or screen recordings</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <p className="text-[11px] text-ink-faint mb-5">
        AutoDoc is open source — you can audit our tracking code anytime. You can change this later in Settings.
      </p>

      <label className="flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-accent px-4 py-3 mb-4 text-left">
        <input
          type="checkbox"
          checked={diagnosticLogUploadConsented}
          onChange={(event) => onDiagnosticLogUploadConsentedChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border-subtle text-sage focus:ring-sage"
          aria-label="Attach technical app logs to error reports"
        />
        <span className="text-[12px] text-ink-muted leading-relaxed">
          <strong className="text-ink font-semibold">Attach technical app logs to error reports</strong>
          {' '}
          if I choose to share diagnostics. This can help debug failures faster, and can stay off while analytics remain on.
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => onNext(true, diagnosticLogUploadConsented)}
          className="w-full px-6 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Share Anonymous Data
        </button>
        <button
          onClick={() => onNext(false, false)}
          className="w-full px-6 py-2.5 text-ink-muted text-[13px] font-medium hover:text-ink transition-colors"
        >
          No Thanks
        </button>
      </div>
    </div>
  )
}
