import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { EventCard } from './EventCard'
import type { CalendarEvent } from '../../../shared/types'

const mockEvent: CalendarEvent = {
  id: 'evt-1',
  googleEventId: 'google-1',
  title: 'Sprint Planning',
  startTime: new Date('2026-03-24T10:00:00').getTime(),
  endTime: new Date('2026-03-24T10:30:00').getTime(),
  attendees: ['alice@example.com', 'bob@example.com'],
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  autoRecord: false,
  syncedAt: Date.now(),
}

describe('EventCard', () => {
  it('renders event title and time', () => {
    render(<EventCard event={mockEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText('Sprint Planning')).toBeInTheDocument()
    expect(screen.getByText(/10:00/)).toBeInTheDocument()
  })

  it('renders meeting platform when URL is present', () => {
    render(<EventCard event={mockEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText(/Google Meet/i)).toBeInTheDocument()
  })

  it('shows auto-record badge when enabled', () => {
    const autoRecordEvent = { ...mockEvent, autoRecord: true }
    render(<EventCard event={autoRecordEvent} onToggleAutoRecord={vi.fn()} />)
    expect(screen.getByText('Auto-record')).toBeInTheDocument()
  })

  it('calls onToggleAutoRecord when toggle is clicked', async () => {
    const onToggle = vi.fn()
    const user = userEvent.setup()
    render(<EventCard event={mockEvent} onToggleAutoRecord={onToggle} />)

    await user.click(screen.getByRole('button', { name: /auto-record/i }))
    expect(onToggle).toHaveBeenCalledWith('evt-1')
  })

  it('renders Record button when onRecord provided', () => {
    render(
      <EventCard
        event={mockEvent}
        onToggleAutoRecord={vi.fn()}
        onRecord={vi.fn()}
      />
    )
    expect(screen.getByText('Record')).toBeInTheDocument()
  })

  it('calls onRecord when Record button clicked', async () => {
    const onRecord = vi.fn()
    const user = userEvent.setup()
    render(
      <EventCard
        event={mockEvent}
        onToggleAutoRecord={vi.fn()}
        onRecord={onRecord}
      />
    )
    await user.click(screen.getByText('Record'))
    expect(onRecord).toHaveBeenCalledWith('evt-1')
  })
})
