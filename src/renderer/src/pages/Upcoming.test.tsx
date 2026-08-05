import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { Upcoming } from './Upcoming'
import { hasCurrentOrImminentMeeting } from '../services/feedback-prompt-safety'
import {
  createCalendarAccount,
  createCalendarEvent,
  installMockElectronApi,
  resetRendererStores
} from '../test/fixtures'

describe('Upcoming', () => {
  beforeEach(() => {
    resetRendererStores()
  })

  it('connects a calendar and renders synced upcoming meetings', async () => {
    const account = createCalendarAccount()
    const event = createCalendarEvent()
    const state = {
      accounts: [] as (typeof account)[],
      events: [event]
    }

    installMockElectronApi({
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:connect': () => {
        state.accounts = [account]
        return account
      },
      'calendar:sync': () => state.events
    })

    render(
      <MemoryRouter>
        <Upcoming />
      </MemoryRouter>
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /connect google calendar/i }))

    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    expect(screen.getByText(/Google Meet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sync/i })).toBeInTheDocument()
  })

  it('shows a recoverable error when calendar connection fails', async () => {
    installMockElectronApi({
      'calendar:get-accounts': () => [],
      'calendar:get-events': () => [],
      'calendar:connect': () => {
        throw new Error('OAuth denied')
      }
    })

    render(
      <MemoryRouter>
        <Upcoming />
      </MemoryRouter>
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /connect microsoft outlook/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /we couldn't connect microsoft outlook/i
    )
    expect(screen.getByRole('button', { name: /connect microsoft outlook/i })).toBeEnabled()
  })

  it('refreshes the visible meetings when the user syncs again', async () => {
    const account = createCalendarAccount()
    const state = {
      accounts: [account],
      events: [] as ReturnType<typeof createCalendarEvent>[]
    }

    installMockElectronApi({
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:sync': () => {
        state.events = [createCalendarEvent({ title: 'Quarterly Review' })]
        return state.events
      }
    })

    render(
      <MemoryRouter>
        <Upcoming />
      </MemoryRouter>
    )

    expect(await screen.findByText(/no upcoming meetings/i)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Sync' }))

    await waitFor(() => {
      expect(screen.getByText('Quarterly Review')).toBeInTheDocument()
    })
  })

  it('suppresses feedback only for current or next-ten-minute meetings', () => {
    const now = new Date('2026-07-31T14:00:00Z').getTime()

    expect(
      hasCurrentOrImminentMeeting(
        [createCalendarEvent({ startTime: now - 5_000, endTime: now + 5_000 })],
        now
      )
    ).toBe(true)
    expect(
      hasCurrentOrImminentMeeting(
        [createCalendarEvent({ startTime: now + 10 * 60_000, endTime: now + 20 * 60_000 })],
        now
      )
    ).toBe(true)
    expect(
      hasCurrentOrImminentMeeting(
        [
          createCalendarEvent({
            startTime: now,
            endTime: now + 24 * 60 * 60_000,
            isAllDay: true
          }),
          createCalendarEvent({ startTime: now + 10 * 60_000 + 1, endTime: now + 20 * 60_000 })
        ],
        now
      )
    ).toBe(false)
  })
})
