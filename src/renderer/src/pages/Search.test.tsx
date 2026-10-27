import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { Search } from './Search'
import { createSearchResult, installMockElectronApi, resetRendererStores } from '../test/fixtures'

function MeetingRouteStub() {
  const { id } = useParams()
  const location = useLocation()
  return <div>{`Meeting route ${id}${location.search}`}</div>
}

describe('Search', () => {
  it('reaches result navigation through Tab and opens matches with Enter', async () => {
    installMockElectronApi({ 'search:query': () => [createSearchResult()] })
    render(
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route path="/search" element={<Search />} />
          <Route path="/recordings/:id" element={<MeetingRouteStub />} />
        </Routes>
      </MemoryRouter>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'transcript' } })
    const header = await screen.findByRole('link', { name: /Roadmap Sync/ })
    const user = userEvent.setup()
    await user.tab()
    expect(header).toHaveFocus()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/Meeting route meeting-1\?tab=transcript/)).toBeInTheDocument()
  })
  it('clears previous matches on a failed query and supports retry', async () => {
    let fail = false
    installMockElectronApi({
      'search:query': () => {
        if (fail) throw new Error('Synthetic failure')
        return [createSearchResult()]
      }
    })
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'previous' } })
    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    fail = true
    fireEvent.change(input, { target: { value: 'new query' } })
    expect(screen.queryByText('Roadmap Sync')).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed. Try again.')
    expect(screen.queryByText(/No results found/)).not.toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('ignores a slow previous response after a new query or clearing the input', async () => {
    const pending: Array<(value: ReturnType<typeof createSearchResult>[]) => void> = []
    installMockElectronApi({
      'search:query': () => new Promise((resolve) => pending.push(resolve))
    })
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(pending).toHaveLength(1))
    fireEvent.change(input, { target: { value: 'new' } })
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]([createSearchResult({ title: 'New result' })]))
    expect(await screen.findByText('New result')).toBeInTheDocument()
    await act(async () => pending[0]([createSearchResult({ title: 'Old result' })]))
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'pending' } })
    await waitFor(() => expect(pending).toHaveLength(3))
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => pending[2]([createSearchResult({ title: 'Late result' })]))
    expect(screen.queryByText('Late result')).not.toBeInTheDocument()
  })
  beforeEach(() => {
    resetRendererStores()
  })

  it('shows transcript and note matches, then navigates into meeting detail', async () => {
    installMockElectronApi({
      'search:query': () => [createSearchResult()]
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
      </MemoryRouter>
    )

    const user = userEvent.setup()
    fireEvent.change(screen.getByPlaceholderText(/search across all meetings/i), {
      target: { value: 'transcript highlights' }
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(await screen.findByText('Roadmap Sync')).toBeInTheDocument()
    expect(screen.getByText(/2 matches across 1 meeting/i)).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === 'We should ship the transcript highlights this week.'
      )
    ).toBeInTheDocument()
    const noteMatch = screen.getByText(
      (_, element) =>
        element?.textContent ===
        'Ship transcript highlights: Launch transcript highlights to the beta cohort on Friday.'
    )
    expect(noteMatch).toBeInTheDocument()

    await user.click(noteMatch)

    await waitFor(() => {
      expect(screen.getByText(/Meeting route meeting-1\?tab=notes&highlight=/i)).toBeInTheDocument()
    })
  })

  it('shows an empty-state result message when no processed content matches', async () => {
    installMockElectronApi({
      'search:query': () => []
    })

    render(
      <MemoryRouter initialEntries={['/search']}>
        <Search />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText(/search across all meetings/i), {
      target: { value: 'nonexistent topic' }
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    expect(await screen.findByText(/no results found for “nonexistent topic”/i)).toBeInTheDocument()
  })
})
