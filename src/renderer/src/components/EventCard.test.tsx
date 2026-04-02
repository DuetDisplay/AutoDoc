import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { EventCard } from './EventCard'
import type { CalendarEvent } from '../../../shared/types'

const mockEvent: CalendarEvent = {
  id: 'evt-1',
  externalId: 'google-1',
  accountId: 'account-1',
  provider: 'google' as const,
  recurringEventId: null,
  title: 'Sprint Planning',
  startTime: new Date('2026-03-24T10:00:00').getTime(),
  endTime: new Date('2026-03-24T10:30:00').getTime(),
  attendees: ['alice@example.com', 'bob@example.com'],
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  autoRecord: 'off',
  syncedAt: Date.now(),
}

describe('EventCard', () => {
  it('renders event title and time', () => {
    render(<EventCard event={mockEvent} onSetAutoRecord={vi.fn()} />)
    expect(screen.getByText('Sprint Planning')).toBeInTheDocument()
    expect(screen.getByText(/10:00/)).toBeInTheDocument()
  })

  it('renders meeting platform when URL is present', () => {
    render(<EventCard event={mockEvent} onSetAutoRecord={vi.fn()} />)
    expect(screen.getByText(/Google Meet/i)).toBeInTheDocument()
  })

  it('shows active auto-record indicator when enabled', () => {
    const autoRecordEvent = { ...mockEvent, autoRecord: 'once' as const }
    render(<EventCard event={autoRecordEvent} onSetAutoRecord={vi.fn()} />)
    expect(screen.getByText('Auto-recording')).toBeInTheDocument()
    expect(screen.getByText(/Auto-record: On/)).toBeInTheDocument()
  })

  it('toggles auto-record on for non-recurring event', async () => {
    const onSet = vi.fn()
    const user = userEvent.setup()
    render(<EventCard event={mockEvent} onSetAutoRecord={onSet} />)

    await user.click(screen.getByRole('button', { name: /auto-record/i }))
    expect(onSet).toHaveBeenCalledWith('evt-1', null, 'once')
  })

  it('toggles auto-record off when already enabled', async () => {
    const onSet = vi.fn()
    const user = userEvent.setup()
    const enabledEvent = { ...mockEvent, autoRecord: 'once' as const }
    render(<EventCard event={enabledEvent} onSetAutoRecord={onSet} />)

    await user.click(screen.getByRole('button', { name: /auto-record/i }))
    expect(onSet).toHaveBeenCalledWith('evt-1', null, 'off')
  })

  it('shows menu for recurring events', async () => {
    const user = userEvent.setup()
    const recurringEvent = { ...mockEvent, recurringEventId: 'series-1' }
    render(<EventCard event={recurringEvent} onSetAutoRecord={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /auto-record/i }))
    expect(screen.getByText('This meeting')).toBeInTheDocument()
    expect(screen.getByText('All in series')).toBeInTheDocument()
  })
})
