import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MeetingDetail } from './MeetingDetail'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  window.electronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string) => {
      if (channel === 'transcription:get-status') return Promise.resolve('pending')
      if (channel === 'transcription:get-progress') return Promise.resolve(undefined)
      if (channel === 'transcription:get-transcript') {
        return Promise.resolve([
          { id: 't1', meetingId: 'test-123', speaker: 'Speaker 1', text: 'Intro', startMs: 0, endMs: 5000, confidence: 0.9 },
        ])
      }
      if (channel === 'segmentation:get-status') return Promise.resolve('complete')
      if (channel === 'segmentation:get-progress') return Promise.resolve(undefined)
      if (channel === 'segmentation:get-segments') {
        return Promise.resolve({
          decisions: [],
          actionItems: [],
          information: [
            {
              id: 's1',
              meetingId: 'test-123',
              category: 'information',
              topic: 'Topic',
              title: 'Test note',
              content: 'Timestamped note',
              assignee: null,
              deadline: null,
              sourceStartMs: 12000,
              sourceEndMs: 12000,
            },
          ],
          discussion: [],
          statusUpdates: [],
        })
      }
      if (channel === 'recording:get-detail') return Promise.resolve({ title: 'Test Meeting', sourceName: 'Zoom', date: Date.now(), durationSeconds: 300 })
      if (channel === 'recording:get-media')
        return Promise.resolve({ hasVideo: true, hasAudio: false, mediaBaseUrl: 'http://127.0.0.1:9' })
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
    expect(document.querySelector('video')).toBeInTheDocument()
  })

  it('resets transcript scroll to the media area when clicking a note timestamp', async () => {
    await renderMeetingDetail()
    const user = userEvent.setup()
    const contentScroll = document.querySelector('[data-content-scroll]') as HTMLDivElement
    expect(contentScroll).toBeTruthy()
    contentScroll.scrollTop = 480

    await user.click(screen.getByRole('button', { name: /0:12/i }))

    expect(contentScroll.scrollTop).toBe(0)
    expect(document.querySelector('video')).toBeInTheDocument()
  })

  it('restores the current transcription percentage when reopening the meeting', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'transcription:get-status') return Promise.resolve('transcribing')
        if (channel === 'transcription:get-progress') return Promise.resolve(42)
        if (channel === 'transcription:get-transcript') return Promise.resolve([])
        if (channel === 'segmentation:get-status') return Promise.resolve('pending')
        if (channel === 'segmentation:get-progress') return Promise.resolve(undefined)
        if (channel === 'segmentation:get-segments') return Promise.resolve(null)
        if (channel === 'recording:get-detail') return Promise.resolve({ title: 'Test Meeting', sourceName: 'Zoom', date: Date.now(), durationSeconds: 300 })
        if (channel === 'recording:get-media') return Promise.resolve({ hasVideo: false, hasAudio: true })
        if (channel === 'speakers:get') return Promise.resolve({})
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any

    await renderMeetingDetail()

    expect(screen.getByText('Transcribing 42%')).toBeInTheDocument()
  })
})
