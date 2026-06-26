import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { Search } from './Search'
import {
  createSearchResult,
  installMockElectronApi,
  resetRendererStores,
} from '../test/fixtures'

function MeetingRouteStub() {
  const { id } = useParams()
  const location = useLocation()
  return <div>{`Meeting route ${id}${location.search}`}</div>
}

describe('Search', () => {
  beforeEach(() => {
    resetRendererStores()
  })

  it('shows transcript and note matches, then navigates into meeting detail', async () => {
    installMockElectronApi({
      'search:query': () => [createSearchResult()],
    })

    render(
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route
            path="/search"
            element={
              <>
                <Search />
              </>
            }
          />
          <Route path="/recordings/:id" element={<MeetingRouteStub />} />
        </Routes>
      </MemoryRouter>,
    )

    const user = userEvent.setup()
    fireEvent.change(screen.getByPlaceholderText(/search across all meetings/i), {
      target: { value: 'transcript highlights' },
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    expect(screen.getByText(/2 matches across 1 meeting/i)).toBeInTheDocument()
    expect(
      screen.getByText((_, element) =>
        element?.textContent === 'We should ship the transcript highlights this week.',
      ),
    ).toBeInTheDocument()
    const noteMatch = screen.getByText((_, element) =>
      element?.textContent ===
      'Ship transcript highlights: Launch transcript highlights to the beta cohort on Friday.',
    )
    expect(noteMatch).toBeInTheDocument()

    await user.click(noteMatch)

    await waitFor(() => {
      expect(screen.getByText(/Meeting route meeting-1\?tab=notes&highlight=/i)).toBeInTheDocument()
    })
  })

  it('shows an empty-state result message when no processed content matches', async () => {
    installMockElectronApi({
      'search:query': () => [],
    })

    render(
      <MemoryRouter initialEntries={['/search']}>
        <Search />
      </MemoryRouter>,
    )

    fireEvent.change(screen.getByPlaceholderText(/search across all meetings/i), {
      target: { value: 'nonexistent topic' },
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(await screen.findByText(/no results found for “nonexistent topic”/i)).toBeInTheDocument()
  })
})
