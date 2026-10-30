import { useT } from '../../services/i18n'
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
  const t = useT()

  const [expanded, setExpanded] = useState(false)

  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-full bg-mist-light flex items-center justify-center mx-auto mb-5">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#5B7B8A"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 20V10" />
          <path d="M12 20V4" />
          <path d="M6 20v-6" />
        </svg>
      </div>

      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">
        {t('ui.helpUsMakeAutoDocBetter')}
      </h2>

      <p className="text-[14px] text-ink-muted leading-relaxed mb-4">
        {t('ui.youCanOptionallyShareAnonymousProductHealthSoWeCanFixCrashesAndImproveAutoD')}
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
        {t('ui.whatExactlyDoWeTrack')}
      </button>

      {expanded && (
        <div className="text-left bg-bg-accent rounded-lg p-4 mb-4 text-[12px] text-ink-muted leading-relaxed">
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span>{t('ui.featureUsageAnonymousFeatureSetupAndRecordingWorkflowEvents')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span>{t('ui.onboardingWhichStepsYouCompleteOrSkip')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span>{t('ui.crashReportsStackTracesWhenSomethingGoesWrong')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span>
                {t('ui.optionalDiagnosticLogsTechnicalAppLogsOnlyIfYouExplicitlyAllowThem')}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sage font-bold mt-[1px]">✓</span>
              <span>{t('ui.appVersionAndOSHelpsUsPrioritizePlatformFixes')}</span>
            </div>
            <div className="border-t border-border-subtle mt-3 pt-3 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-clay font-bold mt-[1px]">✗</span>
                <span>{t('ui.meetingContentMeetingTitlesTranscriptsOrCalendarData')}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-clay font-bold mt-[1px]">✗</span>
                <span>{t('ui.namesEmailsOrAnyPersonalInformation')}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-clay font-bold mt-[1px]">✗</span>
                <span>{t('ui.audioVideoOrScreenRecordings')}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      <label className="flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-accent px-4 py-3 mb-4 text-left">
        <input
          type="checkbox"
          checked={diagnosticLogUploadConsented}
          onChange={(event) => onDiagnosticLogUploadConsentedChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border-subtle text-sage focus:ring-sage"
          aria-label={t('ui.alsoShareAnonymousLogsIfSomethingBreaks')}
        />
        <span className="text-[12px] text-ink-muted leading-relaxed">
          {t('ui.alsoShareAnonymousLogsIfSomethingBreaks')}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => onNext(true, diagnosticLogUploadConsented)}
          className="i18n-btn w-full px-6 py-3 bg-sage text-on-brand rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          {t('ui.shareAnonymousProductHealth')}
        </button>
        <button
          onClick={() => onNext(false, false)}
          className="w-full px-6 py-2.5 text-ink-muted text-[13px] font-medium hover:text-ink transition-colors"
        >
          {t('ui.notNow')}
        </button>
      </div>
    </div>
  )
}
