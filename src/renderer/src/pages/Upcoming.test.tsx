import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { Upcoming } from './Upcoming'
import {
  createCalendarAccount,
  createCalendarEvent,
  installMockElectronApi,
  resetRendererStores,
} from '../test/fixtures'

describe('Upcoming', () => {
  beforeEach(() => {
    resetRendererStores()
  })

  it('connects a calendar and renders synced upcoming meetings', async () => {
    const account = createCalendarAccount()
    const event = createCalendarEvent()
    const state = {
      accounts: [] as typeof account[],
      events: [event],
    }

    installMockElectronApi({
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:connect': () => {
        state.accounts = [account]
        return account
      },
      'calendar:sync': () => state.events,
    })

    render(
      <MemoryRouter>
        <Upcoming />
      </MemoryRouter>,
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /connect google calendar/i }))

    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    expect(screen.getByText(/Google Meet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sync/i })).toBeInTheDocument()
  })

  it('refreshes the visible meetings when the user syncs again', async () => {
    const account = createCalendarAccount()
    const state = {
      accounts: [account],
      events: [] as ReturnType<typeof createCalendarEvent>[],
    }

    installMockElectronApi({
      'calendar:get-accounts': () => state.accounts,
      'calendar:get-events': () => state.events,
      'calendar:sync': () => {
        state.events = [createCalendarEvent({ title: 'Quarterly Review' })]
        return state.events
      },
    })

    render(
      <MemoryRouter>
        <Upcoming />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/no upcoming meetings/i)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Sync' }))

    await waitFor(() => {
      expect(screen.getByText('Quarterly Review')).toBeInTheDocument()
    })
  })
})
