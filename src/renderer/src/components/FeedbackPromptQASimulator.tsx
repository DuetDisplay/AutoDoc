import { translate, type MessageKey } from '../../../shared/i18n'
import { dateLocaleForUiLanguage } from '../../../shared/ui-language'
import { readCachedUiLanguage } from '../services/document-language'
import { useT } from '../services/i18n'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  FeedbackPromptQAScenario,
  FeedbackPromptQASnapshot,
  FeedbackPromptSurface
} from '../../../shared/types'
import { ROUTES } from '../../../shared/constants'
import { isAnalyticsConfigured } from '../services/analytics'

const QA_SIMULATOR_MARKER = 'AUTODOC_QA_FEEDBACK_SIMULATOR_V1'

const REASON_LABELS: Record<string, MessageKey> = {
  'eligible-initial': 'ui.readyToShowTheFirstPrompt',
  'eligible-reminder': 'ui.readyToShowTheFinalReminder',
  'state-unavailable': 'ui.encryptedPromptStateIsUnavailable',
  'dependency-unavailable': 'ui.aPromptDependencyIsUnavailable',
  'onboarding-incomplete': 'ui.finishOnboardingBeforeThePromptCanAppear',
  busy: 'ui.aLiveSafetyGateIsActiveWindowRecordingProcessingCriticalUIOrUpdate',
  'support-unavailable': 'ui.theSupportAddressIsUnavailable',
  'contact-initiated': 'ui.suppressedBecauseSupportWasAlreadyContacted',
  'never-ask-again': 'ui.suppressedByDonTAskAgain',
  'baseline-unavailable': 'ui.theLocalEligibilityBaselineIsUnavailable',
  'usage-threshold-not-met': 'ui.naturalSessionAndTimeThresholdsAreNotMet',
  'reminder-not-due': 'ui.theFinalReminderIsNotDueYet',
  'reminder-already-shown': 'ui.bothPermittedImpressionsHaveBeenShown',
  'reservation-active': 'ui.anotherPromptSurfaceHasAnActiveReservation',
  'reservation-unavailable': 'ui.thePromptReservationIsUnavailable'
}

const SCENARIO_LABELS: Record<FeedbackPromptQAScenario, MessageKey> = {
  reset: 'ui.naturalEligibilityRestored',
  initial: 'ui.firstPromptStateLoaded',
  reminder: 'ui.finalReminderStateLoaded',
  contacted: 'ui.alreadyContactedSuppressionLoaded',
  never: 'ui.donTAskAgainSuppressionLoaded'
}

function formatTimestamp(value: number | null | undefined): string {
  if (value == null) return translate(readCachedUiLanguage(), 'ui.notSet')
  return new Date(value).toLocaleString(dateLocaleForUiLanguage(readCachedUiLanguage()))
}

function StatusSummary({
  snapshot,
  analyticsConsent
}: {
  snapshot: FeedbackPromptQASnapshot | null
  analyticsConsent: boolean | null
}): ReactElement {
  const t = useT()

  if (!snapshot) {
    return <p className="text-[12px] text-ink-muted">{t('ui.statusUnavailable')}</p>
  }

  const state = snapshot.state
  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border px-3 py-2.5 ${
          snapshot.eligible
            ? 'border-sage/30 bg-sage-light/60'
            : 'border-border-subtle bg-bg-card/60'
        }`}
      >
        <p className="text-[12px] font-semibold text-ink">
          {snapshot.eligible ? t('ui.eligibleNow') : t('ui.currentlySuppressed')}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          {t(REASON_LABELS[snapshot.reason] ?? 'ui.currentlySuppressed')}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <dt className="text-ink-faint">{t('ui.qualifyingSessions')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {state
              ? t('ui.sessionsAcrossDaysDayS', {
                  sessions: state.qualifyingSessionCount,
                  days: state.qualifyingSessionDates.length
                })
              : t('ui.unavailable')}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.liveGates')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {snapshot.windowForegrounded
              ? t('ui.windowForegrounded')
              : t('ui.windowNotForegrounded')}{' '}
            ·{' '}
            {snapshot.supportAvailable
              ? t('ui.supportAddressConfigured')
              : t('ui.supportUnavailable')}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.firstPromptShown')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.initialPromptShownAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.finalReminderShown')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.reminderPromptShownAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.contactInitiated')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.contactInitiatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.donTAskAgain')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {state?.neverAskAgain ? t('ui.yes') : t('ui.no')}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">{t('ui.analyticsDelivery')}</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {isAnalyticsConfigured() ? t('ui.postHogConfigured') : t('ui.postHogNotConfigured')} ·{' '}
            {analyticsConsent === true ? t('ui.consentOn') : t('ui.consentOff')}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function FeedbackPromptQASimulator(): ReactElement {
  const t = useT()

  const navigate = useNavigate()
  const [surface, setSurface] = useState<FeedbackPromptSurface>('upcoming')
  const [snapshot, setSnapshot] = useState<FeedbackPromptQASnapshot | null>(null)
  const [analyticsConsent, setAnalyticsConsent] = useState<boolean | null>(null)
  const [pendingScenario, setPendingScenario] = useState<
    FeedbackPromptQAScenario | 'refresh' | null
  >(null)
  const [notice, setNotice] = useState<{
    scenario: FeedbackPromptQAScenario
    reason?: MessageKey
  } | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setPendingScenario('refresh')
    setError(null)
    try {
      const [next, consent] = await Promise.all([
        window.electronAPI.invoke('qa:feedback-prompt:get-state'),
        window.electronAPI.invoke('prefs:get-analytics-consent')
      ])
      if (!next) throw new Error('The QA simulator is unavailable in this process.')
      setSnapshot(next)
      setAnalyticsConsent(consent === true)
    } catch {
      setError('ui.couldNotReadFeedbackPromptState')
    } finally {
      setPendingScenario(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openSurface = useCallback((): void => {
    navigate(surface === 'upcoming' ? ROUTES.upcoming : ROUTES.recordings)
  }, [navigate, surface])

  const applyScenario = useCallback(
    async (scenario: FeedbackPromptQAScenario, openAfter = false): Promise<void> => {
      setPendingScenario(scenario)
      setNotice(null)
      setError(null)
      try {
        const next = await window.electronAPI.invoke('qa:feedback-prompt:set-scenario', scenario)
        if (!next) throw new Error('The QA simulator rejected this state change.')
        setSnapshot(next)

        if (openAfter && (!next.eligible || next.kind !== scenario)) {
          const reason = REASON_LABELS[next.reason] ?? 'ui.currentlySuppressed'
          setNotice({ scenario, reason })
        } else {
          setNotice({ scenario })
          if (openAfter) openSurface()
        }
      } catch {
        setError('ui.couldNotChangeFeedbackPromptState')
      } finally {
        setPendingScenario(null)
      }
    },
    [openSurface]
  )

  const busy = pendingScenario !== null

  return (
    <section
      aria-label={t('ui.feedbackPromptSimulator')}
      aria-busy={busy}
      data-qa-simulator={QA_SIMULATOR_MARKER}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{t('ui.feedbackPromptSimulator')}</h3>
        <span className="rounded-full border border-clay/30 bg-clay-light px-2 py-0.5 text-[9px] font-bold tracking-[0.12em] text-clay-dark">
          {t('ui.qABUILD')}
        </span>
      </div>

      <div className="rounded-xl border border-clay/30 bg-bg-accent px-4 py-4">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          {t('ui.loadADeterministicLocalStateThenExerciseTheRealPromptPersistenceSupportEmai')}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {t('ui.toVerifyRemoteAnalyticsDeliveryBuildWithVITEPOSTHOGKEYAndEnableAnalyticsCra')}
        </p>

        <fieldset className="mt-4">
          <legend className="text-[11px] font-semibold text-ink">{t('ui.openThePromptOn')}</legend>
          <div className="mt-2 inline-flex flex-wrap rounded-lg border border-border-subtle bg-bg-card p-1">
            {(
              [
                ['upcoming', 'Upcoming'],
                ['ai_notes', 'AI Notes']
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-sage/50 ${
                  surface === value ? 'bg-ink text-on-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="qa-feedback-surface"
                  value={value}
                  checked={surface === value}
                  onChange={() => setSurface(value)}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('initial', true)}
            className="i18n-btn rounded-lg bg-ink px-3 py-2 text-[11px] font-semibold text-on-ink transition-colors hover:bg-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.showFirstPrompt')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('reminder', true)}
            className="i18n-btn rounded-lg bg-ink px-3 py-2 text-[11px] font-semibold text-on-ink transition-colors hover:bg-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.showFinalReminder')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={openSurface}
            className="i18n-btn rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-[11px] font-semibold text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.openSelectedSurface')}
          </button>
        </div>

        <div className="my-4 border-t border-border-subtle" />

        <p className="text-[11px] font-semibold text-ink">{t('ui.suppressionAndResetStates')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('contacted')}
            className="i18n-btn rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.setAlreadyContacted')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('never')}
            className="i18n-btn rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.setDonTAskAgain')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('reset')}
            className="i18n-btn rounded-lg border border-border-subtle bg-bg-card px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.resetNaturalEligibility')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-lg px-2 py-2 text-[11px] font-medium text-sage transition-colors hover:text-sage-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('ui.refreshStatus')}
          </button>
        </div>

        <div className="mt-4" aria-live="polite">
          {notice && (
            <p className="mb-2 text-[11px] font-medium text-sage-dark">
              {notice.reason
                ? t('ui.resultPromptNotOpenedReason', {
                    result: t(SCENARIO_LABELS[notice.scenario]),
                    reason: t(notice.reason)
                  })
                : t(SCENARIO_LABELS[notice.scenario])}
            </p>
          )}
          {error && <p className="mb-2 text-[11px] font-medium text-clay-dark">{t(error)}</p>}
          <StatusSummary snapshot={snapshot} analyticsConsent={analyticsConsent} />
        </div>
      </div>
    </section>
  )
}
