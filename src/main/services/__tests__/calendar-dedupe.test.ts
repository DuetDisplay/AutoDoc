import { describe, expect, it } from 'vitest'
import { dedupeCalendarEvents, getCalendarAccountIdentity, isSameCalendarAccount } from '../calendar-dedupe'
import type { CalendarAccount, CalendarEvent } from '../../../shared/types'

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'google_evt-1',
    externalId: 'evt-1',
    accountId: 'acct-1',
    provider: 'google',
    recurringEventId: null,
    title: 'Standup',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_180_000,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: 100,
    ...overrides,
  }
}

function makeAccount(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: 'acct-1',
    provider: 'google',
    email: 'person@example.com',
    connectedAt: 100,
    ...overrides,
  }
}

describe('dedupeCalendarEvents', () => {
  it('collapses identical provider events from duplicate accounts', () => {
    const events = dedupeCalendarEvents([
      makeEvent({ accountId: 'acct-1', id: 'google_evt-1', syncedAt: 100 }),
      makeEvent({ accountId: 'acct-2', id: 'google_evt-1', syncedAt: 200 }),
    ])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acct-2',
      externalId: 'evt-1',
    })
  })

  it('keeps the richer duplicate event payload when one has more meeting data', () => {
    const events = dedupeCalendarEvents([
      makeEvent({ accountId: 'acct-1', meetingUrl: null, attendees: [], syncedAt: 100 }),
      makeEvent({
        accountId: 'acct-2',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        attendees: ['a@example.com'],
        syncedAt: 90,
      }),
    ])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acct-2',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      attendees: ['a@example.com'],
    })
  })

  it('does not collapse separate recurring instances', () => {
    const events = dedupeCalendarEvents([
      makeEvent({ externalId: 'evt-1', startTime: 1_700_000_000_000 }),
      makeEvent({ externalId: 'evt-2', startTime: 1_700_086_400_000 }),
    ])

    expect(events).toHaveLength(2)
  })
})

describe('isSameCalendarAccount', () => {
  it('matches accounts with the same provider and real email', () => {
    expect(
      isSameCalendarAccount(
        makeAccount({ id: 'acct-1', email: 'Person@Example.com' }),
        makeAccount({ id: 'acct-2', email: 'person@example.com' }),
      )
    ).toBe(true)
  })

  it('does not merge placeholder unknown accounts', () => {
    expect(
      isSameCalendarAccount(
        makeAccount({ id: 'acct-1', email: 'unknown@gmail.com' }),
        makeAccount({ id: 'acct-2', email: 'unknown@gmail.com' }),
      )
    ).toBe(false)
  })

  it('matches accounts with the same provider and refresh token when email is unknown', () => {
    expect(
      isSameCalendarAccount(
        makeAccount({ id: 'acct-1', email: 'unknown@gmail.com' }),
        makeAccount({ id: 'acct-2', email: 'unknown@gmail.com' }),
        { refresh_token: 'refresh-123' },
        { refresh_token: 'refresh-123' },
      )
    ).toBe(true)
  })
})

describe('getCalendarAccountIdentity', () => {
  it('prefers real email identity over token identity', () => {
    expect(
      getCalendarAccountIdentity(
        makeAccount({ provider: 'google', email: 'person@example.com' }),
        { refresh_token: 'refresh-123' },
      )
    ).toBe('google:email:person@example.com')
  })
})
