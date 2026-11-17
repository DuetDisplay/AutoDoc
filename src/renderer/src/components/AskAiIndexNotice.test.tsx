import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AskAiIndexNotice } from './AskAiIndexNotice'
import { installMockElectronApi } from '../test/fixtures'
import type { AskAiIndexStatus } from '../../../shared/ask-ai-index-status'

afterEach(() => vi.useRealTimers())
it('stays hidden for idle, unavailable and trivial work', async () => {
  const api = installMockElectronApi({
    'chat:index-status': { state: 'idle', percent: 0, significant: false }
  })
  render(<AskAiIndexNotice />)
  for (const status of [
    { state: 'idle', percent: 0, significant: false },
    { state: 'unavailable', percent: 0, significant: true },
    { state: 'preparing', percent: 90, significant: false }
  ] as AskAiIndexStatus[]) {
    await act(async () => api.emit('chat:index-status-changed', status))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  }
})
it('delays preparing, shows paused, keeps progress silent and hides immediately on ready', async () => {
  vi.useFakeTimers()
  const api = installMockElectronApi({
    'chat:index-status': { state: 'preparing', percent: 10, significant: true }
  })
  const { container } = render(<AskAiIndexNotice />)
  await act(async () => {})
  act(() => vi.advanceTimersByTime(1999))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1))
  const live = container.querySelector('[data-ask-ai-index-announcement]')!
  const initialAnnouncement = live.textContent
  expect(screen.getByRole('status')).toBeInTheDocument()
  expect(container.querySelector('[data-index-state="preparing"]')).toHaveTextContent('10%')
  act(() =>
    api.emit('chat:index-status-changed', { state: 'preparing', percent: 45, significant: true })
  )
  expect(container.querySelector('[data-index-state="preparing"]')).toHaveTextContent('45%')
  expect(live.textContent).toBe(initialAnnouncement)
  act(() =>
    api.emit('chat:index-status-changed', { state: 'paused', percent: 45, significant: true })
  )
  expect(container.querySelector('[data-index-state="paused"]')).toHaveTextContent(
    'Preparation paused'
  )
  expect(live.textContent).not.toBe(initialAnnouncement)
  const pausedAnnouncement = live.textContent
  act(() =>
    api.emit('chat:index-status-changed', { state: 'paused', percent: 46, significant: true })
  )
  expect(live.textContent).toBe(pausedAnnouncement)
  act(() =>
    api.emit('chat:index-status-changed', { state: 'ready', percent: 100, significant: true })
  )
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(live).toBeEmptyDOMElement()
})

it('uses starting copy at zero and exposes current progress outside the live announcement', async () => {
  vi.useFakeTimers()
  const api = installMockElectronApi({
    'chat:index-status': { state: 'paused', percent: 0, significant: true }
  })
  const { container } = render(<AskAiIndexNotice />)
  await act(async () => {})
  act(() => vi.advanceTimersByTime(2000))
  const banner = container.querySelector('[data-ask-ai-index-banner]')!
  expect(banner).toHaveTextContent('Preparing your meetings')
  expect(banner).not.toHaveTextContent('0%')
  const startingBar = screen.getByRole('progressbar', { name: 'Preparing your meetings' })
  expect(startingBar).toHaveAttribute('aria-valuenow', '0')
  expect(startingBar.firstElementChild).toHaveStyle({ width: '4%' })
  expect(container.querySelector('[data-ask-ai-index-announcement]')).toHaveTextContent('paused')
  expect(banner.querySelector('[aria-hidden="true"]')).toBeNull()
  expect(banner.closest('[aria-live]')).toBeNull()
  act(() =>
    api.emit('chat:index-status-changed', { state: 'preparing', percent: 42, significant: true })
  )
  const live = container.querySelector('[data-ask-ai-index-announcement]')!
  const prior = live.textContent
  expect(prior).not.toMatch(/\d|%/)
  act(() =>
    api.emit('chat:index-status-changed', { state: 'preparing', percent: 63, significant: true })
  )
  expect(banner).toHaveTextContent('63%')
  expect(live.textContent).toBe(prior)
})

it('shows a labelled progress bar with the percent, and a grey static bar when paused', async () => {
  vi.useFakeTimers()
  const api = installMockElectronApi({
    'chat:index-status': { state: 'preparing', percent: 45, significant: true }
  })
  render(<AskAiIndexNotice />)
  await act(async () => {})
  act(() => vi.advanceTimersByTime(2000))
  const bar = screen.getByRole('progressbar', { name: 'Preparing your meetings' })
  expect(bar).toHaveAttribute('aria-valuenow', '45')
  expect(bar.firstElementChild).toHaveStyle({ width: '45%' })
  expect(bar.firstElementChild).toHaveClass('bg-sage', 'transition-[width]')
  expect(screen.getByText('45%')).toHaveClass('tabular-nums')
  expect(screen.getByText(/You can ask now/)).toBeInTheDocument()
  act(() =>
    api.emit('chat:index-status-changed', { state: 'paused', percent: 45, significant: true })
  )
  const paused = screen.getByRole('progressbar', { name: 'Preparation paused' })
  expect(paused).toHaveAttribute('aria-valuenow', '45')
  expect(paused.firstElementChild).toHaveClass('bg-control-track-off')
  expect(paused.firstElementChild).not.toHaveClass('transition-[width]')
  expect(screen.getByText('45%')).toBeInTheDocument()
  expect(screen.getByText(/continues after the recording or notes finish/)).toBeInTheDocument()
})
