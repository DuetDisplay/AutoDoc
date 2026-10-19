import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingControls } from '../RecordingControls'
import { useRecordingPickerStore } from '../../stores/recording-picker'
import { useToastStore } from '../../stores/toast'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useRecordingPickerStore.getState().closePicker()
  useToastStore.setState({ activeToast: null })
  window.electronAPI = {
    send: vi.fn(),
    invoke: mockInvoke,
    on: vi.fn(() => () => {})
  } as any
})

describe('RecordingControls', () => {
  it('keeps the detector context and meeting intent when the user chooses an ambiguous window', async () => {
    const onStartRecording = vi.fn(async () => {})
    const selectionContext = {
      eventId: 'timed',
      recurringEventId: 'timed-series',
      providerHint: 'slack'
    }
    useRecordingPickerStore.getState().openPicker({
      title: 'Select the meeting window',
      sources: [{ id: 'window:1', name: 'Jamal - Duet Display – Slack', thumbnailDataUrl: '' }],
      selectionContext,
      trigger: 'auto_record'
    })
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={onStartRecording}
        onStopRecording={() => {}}
        onFetchSources={async () => []}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Jamal - Duet Display – Slack' }))
    expect(onStartRecording).toHaveBeenCalledWith(
      'window:1',
      'Jamal - Duet Display – Slack',
      selectionContext,
      expect.objectContaining({ recordingIntent: 'meeting', providerId: 'slack' }),
      { rememberSource: true }
    )
    expect(useRecordingPickerStore.getState().isOpen).toBe(false)
  })
  it('logs which scored source the user picked and whether it was the suggestion', async () => {
    useRecordingPickerStore.getState().openPicker({
      title: 'Select the meeting window',
      sources: [
        { id: 'window:1', name: 'Jamal - Duet Display – Slack', thumbnailDataUrl: '' },
        { id: 'screen:0', name: 'Entire Screen', thumbnailDataUrl: '' }
      ],
      detectedId: 'window:1',
      selectionContext: { eventId: 'timed', recurringEventId: null, providerHint: 'slack' },
      trigger: 'auto_record',
      scoredSourceIds: ['window:1'],
      requestId: 7,
      diagnosticTrigger: 'select_window'
    })
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={async () => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => []}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Entire Screen' }))
    const logged = mockInvoke.mock.calls.filter(
      ([channel]) => channel === 'diagnostics:record-action'
    )
    expect(logged).toEqual([
      [
        'diagnostics:record-action',
        {
          category: 'recording',
          action: 'recording_picker_result',
          details: {
            trigger: 'select_window',
            requestId: 7,
            eventId: 'timed',
            result: 'picked',
            pickedIndex: null,
            pickedWasSuggested: false,
            sourceType: 'screen'
          }
        }
      ]
    ])
    expect(JSON.stringify(logged)).not.toContain('Jamal')
  })

  it('logs when the user cancels the picker', async () => {
    useRecordingPickerStore.getState().openPicker({
      title: 'Select the meeting window',
      sources: [{ id: 'window:1', name: 'Jamal - Slack', thumbnailDataUrl: '' }],
      selectionContext: { eventId: 'timed', recurringEventId: null, providerHint: 'slack' },
      trigger: 'auto_record',
      requestId: 9,
      diagnosticTrigger: 'select_window'
    })
    const { container } = render(
      <RecordingControls
        isRecording={false}
        onStartRecording={async () => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => []}
      />
    )
    await userEvent.click(container.querySelector('.fixed.inset-0') as HTMLElement)
    expect(mockInvoke).toHaveBeenCalledWith(
      'diagnostics:record-action',
      expect.objectContaining({
        action: 'recording_picker_result',
        details: expect.objectContaining({ requestId: 9, result: 'cancelled' })
      })
    )
    expect(useRecordingPickerStore.getState().isOpen).toBe(false)
  })

  it('logs a manual picker opening with the suggestion state', async () => {
    mockInvoke.mockResolvedValue(undefined)
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => [
          { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: '' },
          { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: '' }
        ]}
      />
    )
    await userEvent.click(screen.getByText('Record'))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('diagnostics:record-action', {
        category: 'recording',
        action: 'recording_picker_opened',
        details: {
          trigger: 'manual',
          requestId: null,
          eventId: null,
          sourceCount: 2,
          suggestionHighlighted: true
        }
      })
    )
  })

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

  it('prefers a window app icon and keeps the complete source name accessible', async () => {
    const sourceName = 'Huddle: #product - AutoDoc - Slack'
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => [
          {
            id: 'window:slack-huddle',
            name: sourceName,
            thumbnailDataUrl: 'data:image/png;base64,thumbnail',
            iconDataUrl: 'data:image/png;base64,icon'
          }
        ]}
      />
    )

    await userEvent.click(screen.getByText('Record'))

    const sourceButton = await screen.findByRole('button', { name: new RegExp(sourceName) })
    const preview = screen.getByTestId('recording-source-preview')
    expect(sourceButton).toBeInTheDocument()
    expect(preview).toHaveAttribute('src', 'data:image/png;base64,icon')
    expect(preview).toHaveAttribute('alt', '')
  })

  it('shows deliberate window and screen placeholders when images are unavailable', async () => {
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => [
          { id: 'window:1', name: 'Notes', thumbnailDataUrl: '' },
          { id: 'screen:0:0', name: 'Entire screen', thumbnailDataUrl: '' }
        ]}
      />
    )

    await userEvent.click(screen.getByText('Record'))

    expect(await screen.findByTestId('window-source-placeholder')).toBeInTheDocument()
    expect(screen.getByTestId('screen-source-placeholder')).toBeInTheDocument()
  })

  it('replaces an image that fails to load with the matching source placeholder', async () => {
    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={async () => [
          {
            id: 'window:1',
            name: 'Slack',
            thumbnailDataUrl: '',
            iconDataUrl: 'data:image/png;base64,broken'
          }
        ]}
      />
    )

    await userEvent.click(screen.getByText('Record'))
    fireEvent.error(await screen.findByTestId('recording-source-preview'))

    expect(await screen.findByTestId('window-source-placeholder')).toBeInTheDocument()
    expect(screen.queryByTestId('recording-source-preview')).not.toBeInTheDocument()
  })

  it('shows a screen permission toast when capture sources cannot be listed', async () => {
    const fetchSources = vi.fn(async () => {
      throw new Error(
        'AutoDoc could not list capture sources. Screen recording permission may be missing.'
      )
    })

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )

    await userEvent.click(screen.getByText('Record'))

    await waitFor(() => {
      expect(useToastStore.getState().activeToast).toMatchObject({
        type: 'screen',
        action: {
          label: 'Open Settings',
          type: 'open-settings',
          target: 'screen'
        }
      })
    })
    expect(useRecordingPickerStore.getState().isOpen).toBe(false)
    expect(screen.getByText('Record')).toBeInTheDocument()
  })

  it('shows a screen permission toast instead of an empty picker when no sources are available', async () => {
    const fetchSources = vi.fn(async () => [])

    render(
      <RecordingControls
        isRecording={false}
        onStartRecording={() => {}}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )

    await userEvent.click(screen.getByText('Record'))

    await waitFor(() => {
      expect(useToastStore.getState().activeToast?.message).toContain(
        'fully quit and reopen AutoDoc'
      )
    })
    expect(screen.queryByText('Select a window to record')).not.toBeInTheDocument()
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
        providerId: 'zoom',
        selectionEventId: null,
        recordingIntent: 'meeting'
      },
      { rememberSource: true }
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
        providerId: 'zoom',
        selectionEventId: null,
        recordingIntent: 'meeting'
      },
      { rememberSource: true }
    )
  })
})
