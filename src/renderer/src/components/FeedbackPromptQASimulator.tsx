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

const REASON_LABELS: Record<string, string> = {
  'eligible-initial': 'Ready to show the first prompt',
  'eligible-reminder': 'Ready to show the final reminder',
  'state-unavailable': 'Encrypted prompt state is unavailable',
  'dependency-unavailable': 'A prompt dependency is unavailable',
  'onboarding-incomplete': 'Finish onboarding before the prompt can appear',
  busy: 'A live safety gate is active (window, recording, processing, critical UI, or update)',
  'support-unavailable': 'The support address is unavailable',
  'contact-initiated': 'Suppressed because support was already contacted',
  'never-ask-again': 'Suppressed by Don’t ask again',
  'baseline-unavailable': 'The local eligibility baseline is unavailable',
  'usage-threshold-not-met': 'Natural session and time thresholds are not met',
  'reminder-not-due': 'The final reminder is not due yet',
  'reminder-already-shown': 'Both permitted impressions have been shown',
  'reservation-active': 'Another prompt surface has an active reservation',
  'reservation-unavailable': 'The prompt reservation is unavailable'
}

function formatTimestamp(value: number | null | undefined): string {
  if (value == null) return 'Not set'
  return new Date(value).toLocaleString()
}

function StatusSummary({
  snapshot,
  analyticsConsent
}: {
  snapshot: FeedbackPromptQASnapshot | null
  analyticsConsent: boolean | null
}): ReactElement {
  if (!snapshot) {
    return <p className="text-[12px] text-ink-muted">Status unavailable.</p>
  }

  const state = snapshot.state
  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border px-3 py-2.5 ${
          snapshot.eligible ? 'border-sage/30 bg-sage-light/60' : 'border-border-subtle bg-white/60'
        }`}
      >
        <p className="text-[12px] font-semibold text-ink">
          {snapshot.eligible ? 'Eligible now' : 'Currently suppressed'}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          {REASON_LABELS[snapshot.reason] ?? snapshot.reason}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <dt className="text-ink-faint">Qualifying sessions</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {state
              ? `${state.qualifyingSessionCount} across ${state.qualifyingSessionDates.length} day(s)`
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Live gates</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {snapshot.windowForegrounded ? 'Window foregrounded' : 'Window not foregrounded'} ·{' '}
            {snapshot.supportAvailable ? 'Support address configured' : 'Support unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">First prompt shown</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.initialPromptShownAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Final reminder shown</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.reminderPromptShownAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Contact initiated</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {formatTimestamp(state?.contactInitiatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Don’t ask again</dt>
          <dd className="mt-0.5 font-medium text-ink">{state?.neverAskAgain ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Analytics delivery</dt>
          <dd className="mt-0.5 font-medium text-ink">
            {isAnalyticsConfigured() ? 'PostHog configured' : 'PostHog not configured'} ·{' '}
            {analyticsConsent === true ? 'consent on' : 'consent off'}
          </dd>
        </div>
      </dl>
    </div>
  )
}

export function FeedbackPromptQASimulator(): ReactElement {
  const navigate = useNavigate()
  const [surface, setSurface] = useState<FeedbackPromptSurface>('upcoming')
  const [snapshot, setSnapshot] = useState<FeedbackPromptQASnapshot | null>(null)
  const [analyticsConsent, setAnalyticsConsent] = useState<boolean | null>(null)
  const [pendingScenario, setPendingScenario] = useState<
    FeedbackPromptQAScenario | 'refresh' | null
  >(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read feedback prompt state.')
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

        const labels: Record<FeedbackPromptQAScenario, string> = {
          reset: 'Natural eligibility restored.',
          initial: 'First-prompt state loaded.',
          reminder: 'Final-reminder state loaded.',
          contacted: 'Already-contacted suppression loaded.',
          never: 'Don’t-ask-again suppression loaded.'
        }
        if (openAfter && (!next.eligible || next.kind !== scenario)) {
          const reason = REASON_LABELS[next.reason] ?? next.reason
          setNotice(`${labels[scenario]} Prompt not opened: ${reason}.`)
        } else {
          setNotice(labels[scenario])
          if (openAfter) openSurface()
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not change feedback prompt state.')
      } finally {
        setPendingScenario(null)
      }
    },
    [openSurface]
  )

  const busy = pendingScenario !== null

  return (
    <section
      aria-label="Feedback prompt simulator"
      aria-busy={busy}
      data-qa-simulator={QA_SIMULATOR_MARKER}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Feedback prompt simulator</h3>
        <span className="rounded-full border border-clay/30 bg-[#F8E7DE] px-2 py-0.5 text-[9px] font-bold tracking-[0.12em] text-clay-dark">
          QA BUILD
        </span>
      </div>

      <div className="rounded-xl border border-clay/30 bg-bg-accent px-4 py-4">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Load a deterministic local state, then exercise the real prompt, persistence, support
          email, and analytics flow. Live recording, processing, meeting, focus, and onboarding
          safety gates still apply. Changes stay inside the isolated AutoDoc QA profile.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          To verify remote analytics delivery, build with VITE_POSTHOG_KEY and enable Analytics &
          Crash Reports above. No key or no consent means no event is sent.
        </p>

        <fieldset className="mt-4">
          <legend className="text-[11px] font-semibold text-ink">Open the prompt on</legend>
          <div className="mt-2 inline-flex rounded-lg border border-border-subtle bg-white p-1">
            {(
              [
                ['upcoming', 'Upcoming'],
                ['ai_notes', 'AI Notes']
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-sage/50 ${
                  surface === value ? 'bg-ink text-white' : 'text-ink-muted hover:text-ink'
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
            className="rounded-lg bg-ink px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Show first prompt
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('reminder', true)}
            className="rounded-lg bg-ink px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Show final reminder
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={openSurface}
            className="rounded-lg border border-border-subtle bg-white px-3 py-2 text-[11px] font-semibold text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Open selected surface
          </button>
        </div>

        <div className="my-4 border-t border-border-subtle" />

        <p className="text-[11px] font-semibold text-ink">Suppression and reset states</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('contacted')}
            className="rounded-lg border border-border-subtle bg-white px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set already contacted
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('never')}
            className="rounded-lg border border-border-subtle bg-white px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Set Don’t ask again
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyScenario('reset')}
            className="rounded-lg border border-border-subtle bg-white px-3 py-2 text-[11px] font-medium text-ink-muted transition-colors hover:border-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset natural eligibility
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-lg px-2 py-2 text-[11px] font-medium text-sage transition-colors hover:text-sage-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh status
          </button>
        </div>

        <div className="mt-4" aria-live="polite">
          {notice && <p className="mb-2 text-[11px] font-medium text-sage-dark">{notice}</p>}
          {error && <p className="mb-2 text-[11px] font-medium text-clay-dark">{error}</p>}
          <StatusSummary snapshot={snapshot} analyticsConsent={analyticsConsent} />
        </div>
      </div>
    </section>
  )
}
