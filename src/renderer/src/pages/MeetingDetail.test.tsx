import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MeetingDetail } from './MeetingDetail'
import {
  createMeetingSegments,
  createTranscript,
  installMockElectronApi,
  resetRendererStores
} from '../test/fixtures'

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
    expect(screen.getAllByText(/analyzing transcript/i).length).toBeGreaterThan(0)

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

  it('shows transcript-only messaging when notes could not be generated', async () => {
    installMockElectronApi({
      'transcription:get-status': 'complete',
      'transcription:get-progress': undefined,
      'transcription:get-transcript': [
        createTranscript({
          meetingId: 'test-123',
          speaker: 'Speaker 1',
          text: 'This transcript is still available even though structured notes were not generated.'
        })
      ],
      'segmentation:get-status': 'no-notes',
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

    expect(screen.getByText('Transcript only')).toBeInTheDocument()
    expect(
      screen.getAllByText(/AutoDoc could not turn this transcript into structured notes/i).length
    ).toBeGreaterThan(0)
  })

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

})
