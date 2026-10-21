import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../../shared/types'
import { matchCalendarEvent } from '../calendar-matcher'

vi.mock('../crypto', () => ({ isEncrypted: vi.fn(), decryptJSON: vi.fn() }))

function event(
  overrides: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'startTime' | 'endTime'>
): CalendarEvent {
  return {
    externalId: overrides.id,
    accountId: 'acct-1',
    provider: 'google',
    recurringEventId: null,
    title: overrides.id,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: 0,
    ...overrides
  }
}

describe('matchCalendarEvent', () => {
  const recordingStart = Date.parse('2026-06-15T14:00:00.000Z')

  it('prefers a timed meeting over an overlapping all-day event', () => {
    const allDay = event({
      id: 'ooo',
      title: 'Out of Office',
      startTime: Date.parse('2026-06-15T00:00:00.000Z'),
      endTime: Date.parse('2026-06-16T00:00:00.000Z'),
      isAllDay: true
    })
    const standup = event({
      id: 'standup',
      title: 'Standup',
      startTime: Date.parse('2026-06-15T13:55:00.000Z'),
      endTime: Date.parse('2026-06-15T14:30:00.000Z')
    })

    expect(matchCalendarEvent([allDay, standup], recordingStart)?.id).toBe('standup')
  })

  it('still prefers a timed event when the all-day start is equally close', () => {
    const start = Date.parse('2026-06-15T00:00:00.000Z')
    const allDay = event({
      id: 'birthday',
      title: 'Birthday',
      startTime: start,
      endTime: Date.parse('2026-06-16T00:00:00.000Z'),
      isAllDay: true
    })
    const earlyCall = event({
      id: 'early-call',
      title: 'Early call',
      startTime: start,
      endTime: Date.parse('2026-06-15T01:00:00.000Z')
    })

    expect(matchCalendarEvent([allDay, earlyCall], start + 30 * 60_000)?.id).toBe('early-call')
  })

  it('ignores all-day blocks even when no timed meeting overlaps', () => {
    const allDay = event({
      id: 'home',
      title: 'Home',
      startTime: Date.parse('2026-06-15T00:00:00.000Z'),
      endTime: Date.parse('2026-06-16T00:00:00.000Z'),
      isAllDay: true
    })

    expect(matchCalendarEvent([allDay], recordingStart)).toBeNull()
  })
})
