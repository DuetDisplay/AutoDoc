import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Onboarding } from './Onboarding'

vi.mock('../services/analytics', () => ({
  recordAnalyticsLocalSignal: vi.fn(),
  trackEvent: vi.fn(),
  identifyConsentedInstall: vi.fn(),
  setAnalyticsConsent: vi.fn(),
  startAnalyticsSession: vi.fn(),
  toDurationBucket: vi.fn(),
  trackConsentSnapshot: vi.fn(),
  trackDailyActiveIfNeeded: vi.fn(),
  trackFirstEventOnce: vi.fn()
}))
vi.mock('../components/onboarding/TranscriptionStep', () => ({
  TranscriptionStep: () => <output>speech setup</output>
}))

let platform = 'darwin'
let savedStep = 12
beforeEach(() => {
  savedStep = 12
  platform = 'darwin'
  window.electronAPI = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'prefs:get-onboarding-step') return savedStep
      if (channel === 'app:get-runtime-info') return { platform }
      if (channel === 'prefs:get-onboarding-language-confirmed') return true
      if (channel === 'support:get-availability') return false
    }),
    on: vi.fn(() => () => {}),
    send: vi.fn()
  } as any
})
it.each(['darwin', 'win32'])(
  'starts fresh %s onboarding with app language before welcome',
  async (value) => {
    platform = value
    render(<Onboarding onComplete={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Choose your language' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AutoDoc' })).not.toBeInTheDocument()
  }
)
it('preserves a saved step ID from the previous onboarding order', async () => {
  savedStep = 7
  render(<Onboarding onComplete={vi.fn()} />)
  expect(await screen.findByRole('status')).toHaveTextContent('speech setup')
  expect(screen.queryByRole('heading', { name: 'Choose your language' })).not.toBeInTheDocument()
})
it('keeps an existing saved welcome step at welcome', async () => {
  savedStep = 0
  render(<Onboarding onComplete={vi.fn()} />)
  expect(await screen.findByRole('heading', { name: 'AutoDoc' })).toBeInTheDocument()
})
