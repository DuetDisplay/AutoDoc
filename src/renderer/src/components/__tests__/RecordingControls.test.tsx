import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingControls } from '../RecordingControls'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = {
    send: vi.fn(),
    invoke: mockInvoke,
    on: vi.fn(() => () => {})
  } as any
})

describe('RecordingControls', () => {
  it('renders start recording button when not recording', () => {
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => []}
      />
    )
    expect(screen.getByText('Record')).toBeInTheDocument()
  })

  it('renders stop button when recording', () => {
    render(
      <RecordingControls
        isRecording
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => []}
      />
    )
    expect(screen.getByText('Stop Recording')).toBeInTheDocument()
  })

  it('shows source picker with auto-detected source highlighted when Record is clicked', async () => {
    const sources = [
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' },
      { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: 'data:image/png;base64,def' }
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))

    expect(fetchSources).toHaveBeenCalled()
    expect(await screen.findByText('Zoom Meeting')).toBeInTheDocument()
    expect(await screen.findByText('Visual Studio Code')).toBeInTheDocument()
    expect(await screen.findByText('Suggested window')).toBeInTheDocument()
  })

  it('pins the suggested source to the top of the picker list', async () => {
    const sources = [
      { id: 'window:1', name: 'Visual Studio Code', thumbnailDataUrl: 'data:image/png;base64,abc' },
      { id: 'window:2', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,def' }
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))

    const options = await screen.findAllByRole('button')
    expect(options[1]).toHaveTextContent('Zoom Meeting')
  })

  it('calls onStartRecording when a source is selected', async () => {
    const onStart = vi.fn()
    const sources = [
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' }
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={onStart}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))
    await userEvent.click(await screen.findByText('Zoom Meeting'))

    expect(onStart).toHaveBeenCalledWith(
      'window:1',
      'Zoom Meeting',
      {
        eventId: null,
        providerHint: null,
        recurringEventId: null
      },
      {
        meetingSourceId: 'window:1',
        meetingSourceName: 'Zoom Meeting',
        providerId: null
      }
    )
  })

  it('passes the detected meeting window as tracking context when the user chooses full-screen capture', async () => {
    const onStart = vi.fn()
    const sources = [
      { id: 'screen:0:0', name: 'Entire screen', thumbnailDataUrl: 'data:image/png;base64,screen' },
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,zoom' }
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={onStart}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))
    await userEvent.click(await screen.findByText('Entire screen'))

    expect(onStart).toHaveBeenCalledWith(
      'screen:0:0',
      'Entire screen',
      {
        eventId: null,
        providerHint: null,
        recurringEventId: null
      },
      {
        meetingSourceId: 'window:1',
        meetingSourceName: 'Zoom Meeting',
        providerId: null
      }
    )
  })
})
