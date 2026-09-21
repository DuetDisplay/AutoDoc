import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MeetingDetail } from './MeetingDetail'
import {
  createMeetingSegments,
  createTranscript,
  installMockElectronApi,
  resetRendererStores
} from '../test/fixtures'
import type { MockElectronAPI } from '../test/fixtures'
import type { MeetingNotesV2 } from '../../../shared/types'

beforeEach(() => {
  resetRendererStores()
  vi.restoreAllMocks()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  installMockElectronApi({
    'transcription:get-status': 'pending',
    'transcription:get-progress': undefined,
    'transcription:get-transcript': [
      {
        id: 't1',
        meetingId: 'test-123',
        speaker: 'Speaker 1',
        text: 'Intro',
        startMs: 0,
        endMs: 5000,
        confidence: 0.9
      }
    ],
    'segmentation:get-status': 'complete',
    'segmentation:get-progress': undefined,
    'segmentation:get-activity': null,
    'segmentation:get-segments': {
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
          sourceEndMs: 12000
        }
      ],
      discussion: [],
      statusUpdates: []
    },
    'recording:get-detail': {
      title: 'Test Meeting',
      sourceName: 'Zoom',
      date: Date.now(),
      durationSeconds: 300
    },
    'recording:get-media': { hasVideo: true, hasAudio: false, mediaBaseUrl: 'http://127.0.0.1:9' },
    'speakers:get': {}
  })
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

describe('memory failure guidance', () => {
  it('retains previous results on Windows and distinguishes explicit Reprocess', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('transcription:get-status', 'complete')
    api.setHandler('transcription:get-reprocess-failure', true)
    await renderMeetingDetail()
    expect(
      await screen.findByText(
        'Reprocessing failed. Your previous transcript and notes are still available.'
      )
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Transcript', exact: true }))
    expect(screen.getByText('Intro')).toBeInTheDocument()
    // The explicit transcript action is in the meeting Settings tab.
    await userEvent.click(screen.getByRole('button', { name: 'Settings', exact: true }))
    const buttons = screen.getAllByRole('button', { name: 'Reprocess', exact: true })
    await userEvent.click(buttons[0])
    expect(api.invoke).toHaveBeenCalledWith('transcription:retry', 'test-123', { reprocess: true })
    await act(async () =>
      api.emit('transcription:status-changed', {
        meetingId: 'test-123',
        status: 'complete',
        reprocessFailed: true
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Transcript', exact: true }))
    expect(screen.getByText('Intro')).toBeInTheDocument()
  })
  it('shows a persisted transcription shortage in Notes and Transcript and clears it on retry', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('transcription:get-status', 'failed')
    api.setHandler('transcription:retry', () =>
      api.setHandler('transcription:get-status', 'queued')
    )
    api.setHandler('transcription:get-memory-failure', {
      available: { value: 1.9, unit: 'GiB' },
      minimum: { value: 2.5, unit: 'GiB' }
    })
    api.setHandler('segmentation:get-status', 'pending')
    await renderMeetingDetail()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your computer doesn’t have enough free RAM to finish transcription. Close other apps, then retry.'
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Available when checked: 1.9 GiB · Minimum to start: 2.5 GiB'
    )
    expect(
      screen.queryByText('Notes will appear here once the transcript is ready.')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Not enough memory')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Transcript', exact: true }))
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum to start: 2.5 GiB')
    await userEvent.click(screen.getByRole('button', { name: 'Retry transcription', exact: true }))
    expect(api.invoke).toHaveBeenCalledWith('transcription:retry', 'test-123')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows notes engine amounts and keeps the finished transcript accessible', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('transcription:get-status', 'complete')
    api.setHandler('segmentation:get-status', 'failed')
    api.setHandler('segmentation:retry', () => api.setHandler('segmentation:get-status', 'queued'))
    api.setHandler('segmentation:get-error-code', 'ollama-insufficient-memory')
    api.setHandler('segmentation:get-memory-failure', {
      available: { value: 1.2, unit: 'GiB' },
      minimum: { value: 3.4, unit: 'GiB' }
    })
    await renderMeetingDetail()
    expect(screen.getByRole('alert')).toHaveTextContent('free RAM to generate notes')
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum to start: 3.4 GiB')
    await userEvent.click(screen.getByRole('button', { name: 'View transcript' }))
    expect(screen.getByText('Intro')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Notes', exact: true }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry notes', exact: true }))
    expect(api.invoke).toHaveBeenCalledWith('segmentation:retry', 'test-123')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('handles a live macOS memory failure without inventing amounts, then removes it on success', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('segmentation:get-status', 'pending')
    await renderMeetingDetail()
    act(() =>
      api.emit('transcription:status-changed', {
        meetingId: 'test-123',
        status: 'failed',
        memoryFailure: {}
      })
    )
    expect(screen.getByRole('alert')).toHaveTextContent('finish transcription')
    expect(screen.queryByText(/Available when checked/)).not.toBeInTheDocument()
    act(() =>
      api.emit('transcription:status-changed', { meetingId: 'test-123', status: 'complete' })
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Not enough memory')).not.toBeInTheDocument()
  })

  it('preserves the generic failure UI for failures without memory evidence', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('transcription:get-status', 'failed')
    api.setHandler('segmentation:get-status', 'pending')
    await renderMeetingDetail()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Failed — Retry')).toBeInTheDocument()
  })

  it('does not blame RAM for an ambiguous Ollama runner crash classified by the legacy fallback heuristic', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('transcription:get-status', 'complete')
    api.setHandler('segmentation:get-status', 'failed')
    api.setHandler('segmentation:get-error-code', 'ollama-insufficient-memory')
    api.setHandler('segmentation:get-memory-failure', undefined)
    await renderMeetingDetail()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Notes couldn’t finish')).toBeInTheDocument()
    expect(screen.getByText('Notes failed — Retry')).toBeInTheDocument()
  })
})

function installNoNotesElectronApi(initialStatus: 'no-notes' | 'failed' = 'no-notes', errorCode?: string) {
  let segmentationStatus: 'no-notes' | 'failed' | 'queued' = initialStatus
  return installMockElectronApi({
    'transcription:get-status': 'complete',
    'transcription:get-progress': undefined,
    'transcription:get-transcript': [
      createTranscript({
        meetingId: 'test-123',
        speaker: 'Speaker 1',
        text: 'This transcript is still available even though structured notes were not generated.'
      })
    ],
    'segmentation:get-status': () => segmentationStatus,
    'segmentation:get-error-code': errorCode,
    'segmentation:get-progress': undefined,
    'segmentation:get-segments': null,
    'segmentation:retry': () => {
      segmentationStatus = 'queued'
    },
    'recording:get-detail': {
      title: 'Test Meeting',
      sourceName: 'Zoom',
      date: Date.now(),
      durationSeconds: 300
    },
    'recording:get-media': {
      hasVideo: false,
      hasAudio: true,
      mediaBaseUrl: 'http://127.0.0.1:9'
    },
    'speakers:get': {}
  })
}

function createEditableNotes(meetingId = 'test-123'): MeetingNotesV2 {
  return {
    schemaVersion: 2,
    meetingId,
    sourceTranscriptRevision:
      'transcript-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceAttributionRevision:
      'notes-attribution-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    overview: {
      text: `The team aligned on the export handoff for ${meetingId}.`,
      sources: [{ startMs: 0, endMs: 5_000 }],
      provenance: 'generated'
    },
    keyTakeaways: [],
    sections: [
      {
        id: `export-section-${meetingId}`,
        title: 'Export handoff',
        summary: null,
        keyPoints: [
          {
            id: `export-note-${meetingId}`,
            title: 'Preserve edits',
            topic: 'Export handoff',
            owner: null,
            deadline: null,
            text: 'Save the latest note edits before exporting.',
            sources: [{ startMs: 1_000, endMs: 4_000 }],
            provenance: 'generated'
          }
        ],
        supportingDetails: []
      }
    ],
    decisions: [],
    nextSteps: []
  }
}

function installExportReadyElectronApi(
  overrides: Record<string, unknown | ((...args: any[]) => unknown)> = {}
): MockElectronAPI {
  return installMockElectronApi({
    'transcription:get-status': 'complete',
    'transcription:get-progress': undefined,
    'transcription:get-transcript': [
      createTranscript({
        meetingId: 'test-123',
        text: 'The latest notes should be included in the exported meeting.'
      })
    ],
    'segmentation:get-status': 'complete',
    'segmentation:get-progress': undefined,
    'segmentation:get-error-code': undefined,
    'segmentation:get-activity': null,
    'segmentation:get-segments': createMeetingSegments(),
    'notes:get-v2': null,
    'recording:get-detail': {
      title: 'Test Meeting',
      sourceName: 'Zoom',
      date: Date.now(),
      durationSeconds: 300
    },
    'recording:get-media': {
      hasVideo: false,
      hasAudio: true,
      mediaBaseUrl: 'http://127.0.0.1:9'
    },
    'speakers:get': {},
    'meeting:export': { status: 'saved' },
    'meeting:copy-notes': { status: 'copied' },
    ...overrides
  })
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

  it('shows the document skeleton placeholder instead of category cards while notes generate', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': 40,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': null,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {}
    })
    await renderMeetingDetail()

    expect(screen.getByText('Generating notes...')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument()
    expect(screen.queryByText('Action Items')).not.toBeInTheDocument()
  })

  it('shows a quiet empty state instead of category cards when complete without notes', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': null,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {}
    })
    await renderMeetingDetail()

    expect(screen.getByText('No notes for this meeting yet.')).toBeInTheDocument()
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument()
  })

  it('switches to Transcript tab on click', async () => {
    await renderMeetingDetail()
    const user = userEvent.setup()

    await user.click(screen.getByText('Transcript'))
    const video = document.querySelector('video')
    expect(video).toBeInTheDocument()
    expect(video).toHaveAttribute('controls')
    expect(video).not.toHaveAttribute('controlsList')
    expect(screen.queryByRole('button', { name: /full screen/i })).not.toBeInTheDocument()
    const watermark = screen.getByText(/Meeting notes by/)
    expect(watermark).toHaveTextContent('Meeting notes by AutoDoc')
    expect(watermark.closest('[aria-hidden="true"]')).toHaveClass('pointer-events-none')

    const api = window.electronAPI as unknown as MockElectronAPI
    act(() => {
      api.emit('prefs:video-watermark-visible-changed', false)
    })

    expect(screen.queryByText(/Meeting notes by/)).not.toBeInTheDocument()
  })

  it('keeps video playback available if the watermark preference cannot be read', async () => {
    const api = window.electronAPI as unknown as MockElectronAPI
    api.setHandler('prefs:get-video-watermark-visible', () =>
      Promise.reject(new Error('preference unavailable'))
    )

    await renderMeetingDetail()
    const user = userEvent.setup()
    await user.click(screen.getByText('Transcript'))

    expect(document.querySelector('video')).toBeInTheDocument()
    expect(screen.getByText(/Meeting notes by/)).toBeInTheDocument()
  })

  it('keeps the watermark above the video when native fullscreen opens', async () => {
    await renderMeetingDetail()
    const user = userEvent.setup()

    await user.click(screen.getByText('Transcript'))
    const video = document.querySelector('video')
    const watermark = screen.getByText(/Meeting notes by/).closest('[aria-hidden="true"]')
    expect(video).toBeInstanceOf(HTMLVideoElement)
    expect(watermark).toBeInstanceOf(HTMLDivElement)

    const showPopover = vi.fn()
    const hidePopover = vi.fn()
    Object.defineProperties(watermark, {
      showPopover: { configurable: true, value: showPopover },
      hidePopover: { configurable: true, value: hidePopover }
    })
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: video
    })

    act(() => document.dispatchEvent(new Event('fullscreenchange')))

    expect(showPopover).toHaveBeenCalledOnce()
    expect(watermark).toHaveAttribute('popover', 'manual')
    expect(watermark).toHaveAttribute('data-fullscreen-watermark-open')

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null
    })
    act(() => document.dispatchEvent(new Event('fullscreenchange')))

    expect(hidePopover).toHaveBeenCalledOnce()
    expect(watermark).not.toHaveAttribute('popover')
    expect(watermark).not.toHaveAttribute('data-fullscreen-watermark-open')
  })

  it('keeps notes actions disabled while generation runs and when no notes were produced', async () => {
    const api = installMockElectronApi({
      'transcription:get-status': 'transcribing',
      'transcription:get-progress': 60,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': 30,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': null,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    const copyButton = screen.getByRole('button', { name: 'Copy notes' })
    const exportButton = screen.getByRole('button', { name: 'Export' })
    expect(copyButton).toBeDisabled()
    expect(exportButton).toBeDisabled()
    expect(copyButton).toHaveAccessibleDescription('Notes are available when generation finishes.')
    expect(exportButton).toHaveAccessibleDescription(
      'Notes are available when generation finishes.'
    )
    expect(screen.getByRole('button', { name: 'Notes' }).parentElement?.parentElement).toContain(
      copyButton
    )
    expect(screen.getByRole('button', { name: 'Notes' }).parentElement?.parentElement).toContain(
      exportButton
    )

    act(() => {
      api.emit('segmentation:status-changed', {
        meetingId: 'test-123',
        status: 'no-notes'
      })
    })

    await waitFor(() => {
      expect(copyButton).toHaveAccessibleDescription('There aren’t any notes to copy or export.')
      expect(exportButton).toHaveAccessibleDescription('There aren’t any notes to copy or export.')
    })
    expect(copyButton).toBeDisabled()
    expect(exportButton).toBeDisabled()
  })

  it('enables notes actions when generated notes exist without waiting on transcript status', async () => {
    installExportReadyElectronApi({
      'transcription:get-status': 'transcribing',
      'transcription:get-progress': 60
    })
    await renderMeetingDetail()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy notes' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
    })
  })

  it('exports the selected format without a presentation variant', async () => {
    const api = installExportReadyElectronApi()
    const user = userEvent.setup()
    await renderMeetingDetail()

    const exportButton = screen.getByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportButton).toBeEnabled())
    await user.click(exportButton)

    expect(screen.getByRole('dialog', { name: 'Export notes' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Full' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Concise' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^PDF/ }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:export', {
        meetingId: 'test-123',
        format: 'pdf'
      })
    })
  })

  it('copies notes for the current meeting in one click', async () => {
    const api = installExportReadyElectronApi()
    const user = userEvent.setup()
    await renderMeetingDetail()

    const copyButton = screen.getByRole('button', { name: 'Copy notes' })
    await waitFor(() => expect(copyButton).toBeEnabled())
    await user.click(copyButton)

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:copy-notes', { meetingId: 'test-123' })
    })
  })

  it('does not let an unrelated title-save failure block notes actions', async () => {
    let rejectTitleWrite!: (error: Error) => void
    const pendingTitleWrite = new Promise<void>((_resolve, reject) => {
      rejectTitleWrite = reject
    })
    const api = installExportReadyElectronApi({
      'recording:update-title': () => pendingTitleWrite
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByText('Test Meeting'))
    const titleEditor = screen.getByRole('textbox')
    await user.clear(titleEditor)
    await user.type(titleEditor, 'Updated title{Enter}')
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('recording:update-title', 'test-123', 'Updated title')
    })

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))
    expect(api.invoke).not.toHaveBeenCalledWith('meeting:copy-notes', expect.anything())

    await act(async () => {
      rejectTitleWrite(new Error('title storage unavailable'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:copy-notes', { meetingId: 'test-123' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
  })

  it('waits for an in-flight notes write before invoking meeting export', async () => {
    const notes = createEditableNotes()
    const order: string[] = []
    let resolveWrite!: (persisted: MeetingNotesV2) => void
    const pendingWrite = new Promise<MeetingNotesV2>((resolve) => {
      resolveWrite = resolve
    })
    const api = installExportReadyElectronApi({
      'notes:get-v2': notes,
      'notes:write-v2': () => {
        order.push('notes-write-started')
        return pendingWrite
      },
      'meeting:export': () => {
        order.push('meeting-exported')
        return { status: 'saved' }
      }
    })
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByRole('button', { name: '+ Add topic' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        'notes:write-v2',
        'test-123',
        expect.any(Object),
        notes.revision
      )
    })

    const exportButton = screen.getByRole('button', { name: 'Export' })
    await user.click(exportButton)
    await user.click(screen.getByRole('button', { name: /^Word/ }))

    expect(api.invoke).not.toHaveBeenCalledWith('meeting:export', expect.anything())
    expect(order).toEqual(['notes-write-started'])

    await act(async () => {
      resolveWrite({
        ...notes,
        revision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      })
      await pendingWrite
    })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:export', {
        meetingId: 'test-123',
        format: 'docx'
      })
    })
    expect(order).toEqual(['notes-write-started', 'meeting-exported'])
  })

  it('waits for an in-flight notes write before copying notes', async () => {
    const notes = createEditableNotes()
    const order: string[] = []
    let resolveWrite!: (persisted: MeetingNotesV2) => void
    const pendingWrite = new Promise<MeetingNotesV2>((resolve) => {
      resolveWrite = resolve
    })
    const api = installExportReadyElectronApi({
      'notes:get-v2': notes,
      'notes:write-v2': () => {
        order.push('notes-write-started')
        return pendingWrite
      },
      'meeting:copy-notes': () => {
        order.push('notes-copied')
        return { status: 'copied' }
      }
    })
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByRole('button', { name: '+ Add topic' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        'notes:write-v2',
        'test-123',
        expect.any(Object),
        notes.revision
      )
    })

    await user.click(screen.getByRole('button', { name: 'Copy notes' }))

    expect(api.invoke).not.toHaveBeenCalledWith('meeting:copy-notes', expect.anything())
    expect(order).toEqual(['notes-write-started'])

    await act(async () => {
      resolveWrite({
        ...notes,
        revision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      })
      await pendingWrite
    })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:copy-notes', { meetingId: 'test-123' })
    })
    expect(order).toEqual(['notes-write-started', 'notes-copied'])
  })

  it('does not export stale notes when an in-flight notes write fails', async () => {
    const notes = createEditableNotes()
    let rejectWrite!: (error: Error) => void
    const pendingWrite = new Promise<MeetingNotesV2>((_resolve, reject) => {
      rejectWrite = reject
    })
    const api = installExportReadyElectronApi({
      'notes:get-v2': notes,
      'notes:write-v2': () => pendingWrite
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByRole('button', { name: '+ Add topic' }))
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        'notes:write-v2',
        'test-123',
        expect.any(Object),
        notes.revision
      )
    })

    await user.click(screen.getByRole('button', { name: 'Export' }))
    await user.click(screen.getByRole('button', { name: /^Word/ }))

    await act(async () => {
      rejectWrite(new Error('notes storage unavailable'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t export notes. Try again.')
    })
    expect(api.invoke).not.toHaveBeenCalledWith('meeting:export', expect.anything())
  })

  it('flushes a debounced legacy notes edit before invoking meeting export', async () => {
    const order: string[] = []
    let resolveSegmentsWrite!: () => void
    const pendingSegmentsWrite = new Promise<void>((resolve) => {
      resolveSegmentsWrite = resolve
    })
    const api = installExportReadyElectronApi({
      'segmentation:save-segments': () => {
        order.push('legacy-notes-write-started')
        return pendingSegmentsWrite
      },
      'meeting:export': () => {
        order.push('meeting-exported')
        return { status: 'saved' }
      }
    })
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByText('Ship transcript highlights'))
    const editor = screen.getByRole('textbox')
    await user.clear(editor)
    await user.type(editor, 'Ship the edited transcript highlights{Enter}')

    await user.click(screen.getByRole('button', { name: 'Export' }))
    await user.click(screen.getByRole('button', { name: /^Word/ }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        'segmentation:save-segments',
        'test-123',
        expect.objectContaining({
          decisions: expect.arrayContaining([
            expect.objectContaining({ title: 'Ship the edited transcript highlights' })
          ])
        })
      )
    })
    expect(api.invoke).not.toHaveBeenCalledWith('meeting:export', expect.anything())
    expect(order).toEqual(['legacy-notes-write-started'])

    await act(async () => {
      resolveSegmentsWrite()
      await pendingSegmentsWrite
    })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('meeting:export', {
        meetingId: 'test-123',
        format: 'docx'
      })
    })
    expect(order).toEqual(['legacy-notes-write-started', 'meeting-exported'])
  })

  it('does not export stale legacy notes after their background save fails', async () => {
    const api = installExportReadyElectronApi({
      'segmentation:save-segments': () => Promise.reject(new Error('legacy notes unavailable'))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const user = userEvent.setup()
    await renderMeetingDetail()

    await user.click(await screen.findByText('Ship transcript highlights'))
    const editor = screen.getByRole('textbox')
    await user.clear(editor)
    await user.type(editor, 'Keep this failed edit visible{Enter}')
    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        'segmentation:save-segments',
        'test-123',
        expect.any(Object)
      )
    })

    await user.click(screen.getByRole('button', { name: 'Export' }))
    await user.click(screen.getByRole('button', { name: /^Word/ }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t export notes. Try again.')
    })
    expect(api.invoke).not.toHaveBeenCalledWith('meeting:export', expect.anything())
  })

  it('keeps notes write queues isolated when the recording route changes', async () => {
    const firstNotes = createEditableNotes('test-123')
    const nextNotes = createEditableNotes('test-456')
    let resolveFirstWrite!: (notes: MeetingNotesV2) => void
    const pendingFirstWrite = new Promise<MeetingNotesV2>((resolve) => {
      resolveFirstWrite = resolve
    })
    const writes: Array<{ meetingId: string; content: MeetingNotesV2 }> = []
    const api = installExportReadyElectronApi({
      'notes:get-v2': (meetingId: string) => (meetingId === 'test-123' ? firstNotes : nextNotes),
      'notes:write-v2': (meetingId: string, content: MeetingNotesV2) => {
        writes.push({ meetingId, content })
        if (meetingId === 'test-123') return pendingFirstWrite
        return {
          ...nextNotes,
          ...content,
          revision: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
        }
      },
      'recording:get-detail': (meetingId: string) => ({
        title: meetingId === 'test-123' ? 'First Meeting' : 'Next Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      })
    })
    const user = userEvent.setup()

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/recordings/test-123']}>
          <Link to="/recordings/test-456">Open next recording</Link>
          <Routes>
            <Route path="/recordings/:id" element={<MeetingDetail />} />
          </Routes>
        </MemoryRouter>
      )
    })

    expect(await screen.findByText(/export handoff for test-123/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Add topic' }))
    await waitFor(() => expect(writes.some((write) => write.meetingId === 'test-123')).toBe(true))

    await user.click(screen.getByRole('link', { name: 'Open next recording' }))
    expect(await screen.findByText(/export handoff for test-456/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '+ Add topic' }))
    await waitFor(() => expect(writes.some((write) => write.meetingId === 'test-456')).toBe(true))

    expect(
      writes.every(({ meetingId, content }) => content.overview?.text.includes(meetingId))
    ).toBe(true)

    await act(async () => {
      resolveFirstWrite({
        ...firstNotes,
        ...writes.find((write) => write.meetingId === 'test-123')?.content,
        revision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      })
      await pendingFirstWrite
    })

    expect(screen.getByText(/export handoff for test-456/)).toBeInTheDocument()
    expect(api.invoke).not.toHaveBeenCalledWith(
      'notes:write-v2',
      'test-123',
      expect.objectContaining({
        overview: expect.objectContaining({ text: expect.stringContaining('test-456') })
      }),
      expect.anything()
    )
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
    installMockElectronApi({
      'transcription:get-status': 'transcribing',
      'transcription:get-progress': 42,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'pending',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    expect(screen.getByText('Transcribing 42%')).toBeInTheDocument()
  })

  it('updates the transcript and notes when processing completes live', async () => {
    const transcript = [
      createTranscript({ meetingId: 'test-123', text: 'Launch the PR regression suite.' })
    ]
    const segments = createMeetingSegments({
      information: [
        {
          id: 'seg-1',
          meetingId: 'test-123',
          category: 'information',
          topic: 'Testing',
          title: 'Regression suite',
          content: 'Launch the PR regression suite after onboarding finishes.',
          assignee: null,
          deadline: null,
          sourceStartMs: 12_000,
          sourceEndMs: 18_000
        }
      ]
    })

    const api = installMockElectronApi({
      'transcription:get-status': 'transcribing',
      'transcription:get-progress': 55,
      'transcription:get-transcript': transcript,
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': 10,
      'segmentation:get-segments': segments,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {
        'speaker-1': { label: 'Taylor' }
      }
    })

    await renderMeetingDetail()

    expect(screen.getByText('Transcribing 55%')).toBeInTheDocument()
    expect(screen.getByText(/writing structured notes/i)).toBeInTheDocument()

    await act(async () => {
      api.emit('transcription:status-changed', {
        meetingId: 'test-123',
        status: 'complete',
        progress: 100
      })
      api.emit('segmentation:status-changed', {
        meetingId: 'test-123',
        status: 'complete',
        progress: 100
      })
      await Promise.resolve()
    })

    expect(await screen.findByText('Regression suite')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText('Transcript'))

    await waitFor(() => {
      expect(screen.getAllByText('Taylor').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('Launch the PR regression suite.')).toBeInTheDocument()
  })

  it('shows slow notes activity only for the open recording and yields immediately to failure', async () => {
    const api = installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': undefined,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': null,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': { hasVideo: false, hasAudio: true },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    await act(async () => {
      api.emit('segmentation:activity-changed', {
        meetingId: 'different-recording',
        activity: 'waiting-for-local-ai'
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Notes are taking longer than usual.')).not.toBeInTheDocument()

    await act(async () => {
      api.emit('segmentation:activity-changed', {
        meetingId: 'test-123',
        activity: 'waiting-for-local-ai'
      })
      await Promise.resolve()
    })
    expect(screen.getByText('Notes are taking longer than usual.')).toBeInTheDocument()
    expect(
      screen.getByText(/AutoDoc is still waiting for the local AI model to respond/i)
    ).toBeInTheDocument()

    await act(async () => {
      api.emit('segmentation:status-changed', {
        meetingId: 'test-123',
        status: 'failed',
        errorCode: 'ollama-unavailable'
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Notes are taking longer than usual.')).not.toBeInTheDocument()
    expect(screen.getByText('Notes failed — Retry')).toBeInTheDocument()
  })

  it('restores slow notes activity when this recording is opened mid-wait', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': undefined,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': 'waiting-for-local-ai',
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': { hasVideo: false, hasAudio: true },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    expect(screen.getByText('Notes are taking longer than usual.')).toBeInTheDocument()
  })

  it('does not let an older status snapshot restore the warning after failure', async () => {
    let resolveInitialStatus: (status: 'segmenting') => void = () => {}
    const initialStatus = new Promise<'segmenting'>((resolve) => {
      resolveInitialStatus = resolve
    })
    const api = installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': initialStatus,
      'segmentation:get-progress': undefined,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': 'waiting-for-local-ai',
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': { hasVideo: false, hasAudio: true },
      'speakers:get': {}
    })

    await renderMeetingDetail()
    await act(async () => {
      api.emit('segmentation:status-changed', {
        meetingId: 'test-123',
        status: 'failed',
        errorCode: 'ollama-unavailable'
      })
      await Promise.resolve()
    })
    expect(screen.getByText('Notes failed — Retry')).toBeInTheDocument()

    await act(async () => {
      resolveInitialStatus('segmenting')
      await initialStatus
      await Promise.resolve()
    })

    expect(screen.getByText('Notes failed — Retry')).toBeInTheDocument()
    expect(screen.queryByText('Notes are taking longer than usual.')).not.toBeInTheDocument()
  })

  it('does not carry slow notes activity into the next recording route', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'segmenting',
      'segmentation:get-progress': undefined,
      'segmentation:get-error-code': undefined,
      'segmentation:get-activity': (meetingId: string) =>
        meetingId === 'test-123' ? 'waiting-for-local-ai' : null,
      'segmentation:get-segments': null,
      'recording:get-detail': (meetingId: string) => ({
        title: meetingId === 'test-123' ? 'First Meeting' : 'Next Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      }),
      'recording:get-media': { hasVideo: false, hasAudio: true },
      'speakers:get': {}
    })

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/recordings/test-123']}>
          <Link to="/recordings/test-456">Open next recording</Link>
          <Routes>
            <Route path="/recordings/:id" element={<MeetingDetail />} />
          </Routes>
        </MemoryRouter>
      )
    })

    expect(screen.getByText('Notes are taking longer than usual.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: 'Open next recording' }))
    expect(screen.queryByText('Notes are taking longer than usual.')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Next Meeting')).toBeInTheDocument())
    expect(screen.queryByText('Notes are taking longer than usual.')).not.toBeInTheDocument()
  })

  it('shows one recoverable no-notes callout instead of repeated note cards', async () => {
    installNoNotesElectronApi()
    await renderMeetingDetail()

    expect(screen.getByText('No notes were generated')).toBeInTheDocument()
    expect(
      screen.getByText(/There wasn’t enough conversation to turn into notes/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/Your transcript is still available/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View transcript' })).toBeInTheDocument()
    expect(screen.queryByText('Decisions')).not.toBeInTheDocument()
    expect(screen.queryByText('Action Items')).not.toBeInTheDocument()
    expect(screen.queryByText('Information Shared')).not.toBeInTheDocument()
    expect(screen.queryByText('Discussion')).not.toBeInTheDocument()
    expect(screen.queryByText('Status Updates')).not.toBeInTheDocument()
  })

  it.each(['failed', 'no-notes'] as const)(
    'restores generation-failure copy from a persisted code with %s status',
    async (status) => {
      installNoNotesElectronApi(status, 'llm-empty-output')
      await renderMeetingDetail()

      expect(screen.getByText('Notes couldn’t finish')).toBeInTheDocument()
      expect(
        screen.getByText(
          'AutoDoc hit a problem writing notes this time. Your transcript is still available.'
        )
      ).toBeInTheDocument()
      expect(screen.queryByText(/There wasn’t enough conversation/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Copy notes' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'View transcript' })).toBeEnabled()
    }
  )

  it.each(['failed', 'no-notes'] as const)(
    'uses the error code from a live %s event and clears it when queued',
    async (status) => {
      const api = installNoNotesElectronApi()
      await renderMeetingDetail()
      act(() =>
        api.emit('segmentation:status-changed', {
          meetingId: 'test-123',
          status,
          errorCode: 'llm-empty-output'
        })
      )
      expect(screen.getByText('Notes couldn’t finish')).toBeInTheDocument()
      expect(screen.queryByText(/There wasn’t enough conversation/)).not.toBeInTheDocument()
      act(() => api.emit('segmentation:status-changed', { meetingId: 'test-123', status: 'queued' }))
      expect(screen.queryByText('Notes couldn’t finish')).not.toBeInTheDocument()
      expect(screen.getByText('Queued for notes')).toBeInTheDocument()
    }
  )

  it.each(['no-notes', 'failed'] as const)(
    'retries %s generation through the existing manual reprocess path',
    async (status) => {
      const api = installNoNotesElectronApi(
        status,
        status === 'failed' ? 'llm-empty-output' : undefined
      )
      await renderMeetingDetail()

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

      expect(api.invoke).toHaveBeenCalledWith('segmentation:retry', 'test-123')
      expect(screen.getByText('Queued for notes')).toBeInTheDocument()
    }
  )

  it.each(['no-notes', 'failed'] as const)(
    'opens the transcript from the %s callout',
    async (status) => {
      installNoNotesElectronApi(status, status === 'failed' ? 'llm-empty-output' : undefined)
      await renderMeetingDetail()

      await userEvent.click(screen.getByRole('button', { name: 'View transcript' }))

      expect(
        screen.getByText(
          'This transcript is still available even though structured notes were not generated.'
        )
      ).toBeInTheDocument()
    }
  )

  it('renames a speaker and keeps the new label visible in transcript view', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [
        createTranscript({
          meetingId: 'test-123',
          speaker: 'speaker-1',
          text: 'We should rename speakers from the meeting detail view.'
        })
      ],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': createMeetingSegments(),
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': {
        'speaker-1': {
          label: 'Speaker 1',
          suggestions: ['Avery']
        }
      },
      'speakers:rename': undefined
    })

    await renderMeetingDetail()

    const user = userEvent.setup()
    await user.click(screen.getByText('Transcript'))
    await user.click(screen.getByRole('button', { name: 'rename' }))
    await user.click(screen.getByRole('button', { name: 'Avery' }))

    await waitFor(() => {
      expect(window.electronAPI.invoke).toHaveBeenCalledWith(
        'speakers:rename',
        'test-123',
        'speaker-1',
        'Avery'
      )
      expect(screen.getAllByText('Avery').length).toBeGreaterThan(0)
    })
  })

  it('keeps Me visible after reprocessing with diarization instead of renaming me to Speaker 2', async () => {
    let transcriptData = [
      createTranscript({
        meetingId: 'test-123',
        speaker: 'me',
        text: 'Initial local transcript before speaker diarization.'
      })
    ]
    let speakerData = {
      me: { label: 'Me' }
    }

    const api = installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': () => transcriptData,
      'transcription:retry': undefined,
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': createMeetingSegments(),
      'recording:get-detail': {
        title: 'Test Meeting',
        sourceName: 'Entire screen',
        date: Date.now(),
        durationSeconds: 300
      },
      'recording:get-media': {
        hasVideo: false,
        hasAudio: true,
        mediaBaseUrl: 'http://127.0.0.1:9'
      },
      'speakers:get': () => speakerData
    })

    await renderMeetingDetail()

    const user = userEvent.setup()
    await user.click(screen.getByText('Settings'))
    await user.click(screen.getAllByRole('button', { name: 'Reprocess' })[0])

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('transcription:retry', 'test-123')

    transcriptData = [
      createTranscript({
        meetingId: 'test-123',
        speaker: 'me',
        text: 'I am still the local speaker after diarization.'
      }),
      createTranscript({
        id: 't-2',
        meetingId: 'test-123',
        speaker: 'speaker_1',
        text: 'Remote teammate joins as the diarized speaker.',
        startMs: 20_000,
        endMs: 26_000,
        confidence: 0.95
      })
    ]
    speakerData = {
      me: { label: 'Me' },
      speaker_1: { label: 'Speaker 1' }
    }

    await act(async () => {
      api.emit('transcription:status-changed', {
        meetingId: 'test-123',
        status: 'complete',
        progress: 100
      })
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: 'Transcript' }))

    await waitFor(() => {
      expect(screen.queryByText(/Meeting notes by/)).not.toBeInTheDocument()
      expect(screen.getAllByText('Me').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Speaker 1').length).toBeGreaterThan(0)
      expect(screen.queryByText('Speaker 2')).not.toBeInTheDocument()
      expect(
        screen.getByText('I am still the local speaker after diarization.')
      ).toBeInTheDocument()
    })
  })

  it('shows a finalizing notice before media has finished flushing', async () => {
    installMockElectronApi({
      'transcription:get-status': 'pending',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'pending',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Zoom — Apr 21 at 7:32 PM',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 12,
        isFinalizing: true
      },
      'recording:get-media': { hasVideo: false, hasAudio: false },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    expect(
      screen.getByText('Wrapping up this recording. It should finish appearing in a moment.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy notes' })).toHaveAccessibleDescription(
      'Notes are available after this recording finishes.'
    )
    expect(screen.getByRole('button', { name: 'Export' })).toHaveAccessibleDescription(
      'Notes are available after this recording finishes.'
    )
  })

  it('shows a video processing placeholder while videoStatus is processing', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Zoom — Apr 21 at 7:32 PM',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 12,
        isFinalizing: false,
        videoStatus: 'processing'
      },
      'recording:get-media': { hasVideo: false, hasAudio: true, audioFile: 'mic.webm' },
      'speakers:get': {}
    })

    await renderMeetingDetail()
    await userEvent.click(screen.getByRole('button', { name: 'Transcript' }))

    expect(screen.getByText('Finishing up your video…')).toBeInTheDocument()
    expect(screen.getByText('Your transcript and notes are ready to use.')).toBeInTheDocument()
  })

  it('keeps the Retry button after a successful video retry request moves to processing', async () => {
    const api = installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Zoom — Apr 21 at 7:32 PM',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 12,
        videoStatus: 'failed'
      },
      'recording:get-media': { hasVideo: false, hasAudio: true, audioFile: 'mic.webm' },
      'speakers:get': {},
      'recording:retry-video': undefined
    })

    await renderMeetingDetail()
    await userEvent.click(screen.getByRole('button', { name: 'Transcript' }))
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('recording:retry-video', 'test-123')
      expect(screen.getByText('Finishing up your video…')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('restores the Retry button when recording:retry-video rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Zoom — Apr 21 at 7:32 PM',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 12,
        videoStatus: 'failed'
      },
      'recording:get-media': { hasVideo: false, hasAudio: true, audioFile: 'mic.webm' },
      'speakers:get': {},
      'recording:retry-video': () => Promise.reject(new Error('persist failed'))
    })

    await renderMeetingDetail()
    await userEvent.click(screen.getByRole('button', { name: 'Transcript' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith('recording:retry-video', 'test-123')
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })
    expect(screen.queryByText('Finishing up your video…')).not.toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('explains when screen video ended early but meeting content was saved', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [],
      'segmentation:get-status': 'complete',
      'segmentation:get-progress': undefined,
      'segmentation:get-segments': null,
      'recording:get-detail': {
        title: 'Zoom — Apr 21 at 7:32 PM',
        sourceName: 'Zoom',
        date: Date.now(),
        durationSeconds: 12,
        videoCaptureEndedEarly: true,
        videoStatus: 'processing'
      },
      'recording:get-media': { hasVideo: false, hasAudio: true, audioFile: 'mic.webm' },
      'speakers:get': {}
    })

    await renderMeetingDetail()

    expect(screen.queryByText('Screen recording ended early')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Transcript' }))

    expect(screen.getByText('Screen recording ended early')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The screen video may be incomplete. Audio, transcript, and notes were saved.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Finishing up your video…')).toBeInTheDocument()
  })
})
