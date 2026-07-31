import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedbackPromptQASnapshot } from '../../../shared/types'
import { installMockElectronApi } from '../test/fixtures'
import { FeedbackPromptQASimulator } from './FeedbackPromptQASimulator'

function snapshot(overrides: Partial<FeedbackPromptQASnapshot> = {}): FeedbackPromptQASnapshot {
  return {
    stateAvailable: true,
    eligible: false,
    kind: null,
    reason: 'usage-threshold-not-met',
    windowForegrounded: true,
    supportAvailable: true,
    state: {
      qualifyingSessionCount: 0,
      qualifyingSessionDates: [],
      lastQualifiedSessionAt: null,
      initialPromptShownAt: null,
      reminderPromptShownAt: null,
      contactInitiatedAt: null,
      neverAskAgain: false
    },
    ...overrides
  }
}

function renderSimulator() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<FeedbackPromptQASimulator />} />
        <Route path="/" element={<p>Upcoming route</p>} />
        <Route path="/recordings" element={<p>AI Notes route</p>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('FeedbackPromptQASimulator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows explicit QA identity and readable natural-state diagnostics', async () => {
    installMockElectronApi({
      'qa:feedback-prompt:get-state': snapshot(),
      'prefs:get-analytics-consent': false
    })

    renderSimulator()

    const simulator = await screen.findByRole('region', { name: 'Feedback prompt simulator' })
    expect(simulator).toHaveAttribute('data-qa-simulator', 'AUTODOC_QA_FEEDBACK_SIMULATOR_V1')
    expect(screen.getByText('QA BUILD')).toBeInTheDocument()
    expect(screen.getByText('Currently suppressed')).toBeInTheDocument()
    expect(screen.getByText('Natural session and time thresholds are not met')).toBeInTheDocument()
    expect(screen.getByText('0 across 0 day(s)')).toBeInTheDocument()
    expect(screen.getByText('PostHog not configured · consent off')).toBeInTheDocument()
  })

  it('loads the first-prompt state and opens the selected real surface', async () => {
    const firstPrompt = snapshot({
      eligible: true,
      kind: 'initial',
      reason: 'eligible-initial',
      state: {
        ...snapshot().state!,
        qualifyingSessionCount: 3,
        qualifyingSessionDates: ['2026-07-31', '2026-07-30'],
        lastQualifiedSessionAt: Date.now()
      }
    })
    const api = installMockElectronApi({
      'qa:feedback-prompt:get-state': snapshot(),
      'qa:feedback-prompt:set-scenario': firstPrompt,
      'prefs:get-analytics-consent': false
    })
    const user = userEvent.setup()
    renderSimulator()

    await screen.findByText('Currently suppressed')
    await user.click(screen.getByRole('radio', { name: 'AI Notes' }))
    await user.click(screen.getByRole('button', { name: 'Show first prompt' }))

    expect(await screen.findByText('AI Notes route')).toBeInTheDocument()
    expect(api.invoke).toHaveBeenCalledWith('qa:feedback-prompt:set-scenario', 'initial')
  })

  it('keeps QA in Settings when a live gate still blocks the requested prompt', async () => {
    const blocked = snapshot({
      reason: 'busy',
      state: {
        ...snapshot().state!,
        qualifyingSessionCount: 3,
        qualifyingSessionDates: ['2026-07-31', '2026-07-30'],
        lastQualifiedSessionAt: Date.now()
      }
    })
    installMockElectronApi({
      'qa:feedback-prompt:get-state': snapshot(),
      'qa:feedback-prompt:set-scenario': blocked,
      'prefs:get-analytics-consent': false
    })
    const user = userEvent.setup()
    renderSimulator()

    await screen.findByText('Currently suppressed')
    await user.click(screen.getByRole('button', { name: 'Show first prompt' }))

    expect(screen.getByRole('region', { name: 'Feedback prompt simulator' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'First-prompt state loaded. Prompt not opened: A live safety gate is active (window, recording, processing, critical UI, or update).'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Upcoming route')).not.toBeInTheDocument()
  })

  it('loads suppression states without leaving Settings and can refresh them', async () => {
    const contacted = snapshot({
      reason: 'contact-initiated',
      state: {
        ...snapshot().state!,
        qualifyingSessionCount: 3,
        qualifyingSessionDates: ['2026-07-31', '2026-07-30'],
        lastQualifiedSessionAt: Date.now(),
        contactInitiatedAt: Date.now()
      }
    })
    const api = installMockElectronApi({
      'qa:feedback-prompt:get-state': snapshot(),
      'qa:feedback-prompt:set-scenario': contacted,
      'prefs:get-analytics-consent': false
    })
    const user = userEvent.setup()
    renderSimulator()

    await screen.findByText('Currently suppressed')
    await user.click(screen.getByRole('button', { name: 'Set already contacted' }))

    expect(await screen.findByText('Already-contacted suppression loaded.')).toBeInTheDocument()
    expect(screen.getByText('Suppressed because support was already contacted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => {
      expect(
        api.invoke.mock.calls.filter(([channel]) => channel === 'qa:feedback-prompt:get-state')
      ).toHaveLength(2)
    })
  })

  it('keeps state controls visible and reports rejected changes', async () => {
    installMockElectronApi({
      'qa:feedback-prompt:get-state': snapshot(),
      'qa:feedback-prompt:set-scenario': null,
      'prefs:get-analytics-consent': false
    })
    const user = userEvent.setup()
    renderSimulator()

    await screen.findByText('Currently suppressed')
    await user.click(screen.getByRole('button', { name: 'Reset natural eligibility' }))
    expect(
      await screen.findByText('The QA simulator rejected this state change.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show first prompt' })).toBeEnabled()
  })
})
