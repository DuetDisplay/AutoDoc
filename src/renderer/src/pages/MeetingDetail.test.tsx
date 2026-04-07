import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MeetingDetail } from './MeetingDetail'

beforeEach(() => {
  window.electronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string) => {
      if (channel === 'transcription:get-status') return Promise.resolve('pending')
      if (channel === 'transcription:get-transcript') return Promise.resolve([])
      if (channel === 'segmentation:get-status') return Promise.resolve('pending')
      if (channel === 'segmentation:get-progress') return Promise.resolve(undefined)
      if (channel === 'segmentation:get-segments') return Promise.resolve(null)
      if (channel === 'recording:get-detail') return Promise.resolve({ title: 'Test Meeting', sourceName: 'Zoom', date: Date.now(), durationSeconds: 300 })
      if (channel === 'recording:get-media')
        return Promise.resolve({ hasVideo: false, hasAudio: false, mediaBaseUrl: 'http://127.0.0.1:9' })
      if (channel === 'speakers:get') return Promise.resolve({})
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  } as any
})

async function renderMeetingDetail() {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={['/recordings/test-123']}>
        <Routes>
          <Route path="/recordings/:id" element={<MeetingDetail />} />
        </Routes>
      </MemoryRouter>
    )
  })
  return result!
}

describe('MeetingDetail', () => {
  it('renders Notes tab by default with all HOM categories', async () => {
    await renderMeetingDetail()
    expect(screen.getByText('Notes')).toBeInTheDocument()
    expect(screen.getByText('Decisions')).toBeInTheDocument()
    expect(screen.getByText('Action Items')).toBeInTheDocument()
    expect(screen.getByText('Information Shared')).toBeInTheDocument()
    expect(screen.getByText('Discussion')).toBeInTheDocument()
    expect(screen.getByText('Status Updates')).toBeInTheDocument()
  })

  it('switches to Transcript tab on click', async () => {
    await renderMeetingDetail()
    const user = userEvent.setup()

    await user.click(screen.getByText('Transcript'))
    expect(screen.getByText(/awaiting transcription\. this will begin/i)).toBeInTheDocument()
  })
})
