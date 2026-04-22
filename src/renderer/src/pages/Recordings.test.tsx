import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Recordings } from './Recordings'

describe('Recordings', () => {
  beforeEach(() => {
    vi.useFakeTimers()

    const segmentationStatuses = ['segmenting', 'segmenting', 'failed']
    const segmentationProgress = [0, 0, undefined]
    let segmentationStatusCall = 0
    let segmentationProgressCall = 0

    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'recording:list') {
          return Promise.resolve([
            {
              meetingId: 'meeting-1',
              title: 'Test Meeting',
              date: Date.now(),
              duration: 60,
              hasVideo: true,
              hasAudio: true,
              transcriptionStatus: 'complete',
            },
          ])
        }
        if (channel === 'segmentation:get-status') {
          const value = segmentationStatuses[Math.min(segmentationStatusCall, segmentationStatuses.length - 1)]
          segmentationStatusCall += 1
          return Promise.resolve(value)
        }
        if (channel === 'segmentation:get-progress') {
          const value = segmentationProgress[Math.min(segmentationProgressCall, segmentationProgress.length - 1)]
          segmentationProgressCall += 1
          return Promise.resolve(value)
        }
        if (channel === 'transcription:get-status') return Promise.resolve('complete')
        if (channel === 'transcription:get-progress') return Promise.resolve(undefined)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-syncs active note jobs from the backend and shows failure after polling', async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <Recordings />
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('Generating notes... 0%')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })

    expect(screen.getByText(/Notes failed/)).toBeInTheDocument()
  })

  it('shows a newly finished meeting without needing a remount', async () => {
    let listCallCount = 0

    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'recording:list') {
          listCallCount += 1
          if (listCallCount === 1) {
            return Promise.resolve([])
          }
          return Promise.resolve([
            {
              meetingId: 'meeting-2',
              title: 'Fresh Notes',
              date: Date.now(),
              duration: 120,
              hasVideo: false,
              hasAudio: true,
              transcriptionStatus: 'queued',
            },
          ])
        }
        if (channel === 'segmentation:get-status') return Promise.resolve('pending')
        if (channel === 'segmentation:get-progress') return Promise.resolve(undefined)
        if (channel === 'transcription:get-status') return Promise.resolve('queued')
        if (channel === 'transcription:get-progress') return Promise.resolve(undefined)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any

    await act(async () => {
      render(
        <MemoryRouter>
          <Recordings />
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('No notes yet. Start a meeting to begin.')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(screen.getByText('Fresh Notes')).toBeInTheDocument()
  })

  it('shows a finalizing note immediately while Windows finishes flushing media', async () => {
    window.electronAPI = {
      send: vi.fn(),
      invoke: vi.fn((channel: string) => {
        if (channel === 'recording:list') {
          return Promise.resolve([
            {
              meetingId: 'meeting-3',
              title: 'Zoom — Apr 21 at 7:32 PM',
              date: Date.now(),
              duration: 12,
              hasVideo: false,
              hasAudio: false,
              isFinalizing: true,
              transcriptionStatus: 'pending',
            },
          ])
        }
        if (channel === 'segmentation:get-status') return Promise.resolve('pending')
        if (channel === 'segmentation:get-progress') return Promise.resolve(undefined)
        if (channel === 'transcription:get-status') return Promise.resolve('pending')
        if (channel === 'transcription:get-progress') return Promise.resolve(undefined)
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
    } as any

    await act(async () => {
      render(
        <MemoryRouter>
          <Recordings />
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('Wrapping up recording...')).toBeInTheDocument()
    expect(screen.getByText(/Zoom/i)).toBeInTheDocument()
  })
})
