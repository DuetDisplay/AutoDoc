import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { MeetingDetail } from './MeetingDetail'

function renderMeetingDetail() {
  return render(
    <MemoryRouter initialEntries={['/recordings/test-123']}>
      <Routes>
        <Route path="/recordings/:id" element={<MeetingDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('MeetingDetail', () => {
  it('renders Notes tab by default with all HOM categories', () => {
    renderMeetingDetail()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('Decisions')).toBeInTheDocument()
    expect(screen.getByText('Action Items')).toBeInTheDocument()
    expect(screen.getByText('Information Shared')).toBeInTheDocument()
    expect(screen.getByText('Discussion')).toBeInTheDocument()
    expect(screen.getByText('Status Updates')).toBeInTheDocument()
  })

  it('switches to Transcript tab on click', async () => {
    renderMeetingDetail()
    const user = userEvent.setup()

    await user.click(screen.getByText('Transcript'))
    expect(screen.getByText(/transcript will appear/i)).toBeInTheDocument()
  })
})
