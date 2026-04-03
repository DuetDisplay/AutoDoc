import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingControls } from '../RecordingControls'
import { useRecordingPickerStore } from '../../stores/recording-picker'

const mockInvoke = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useRecordingPickerStore.getState().closePicker()
  window.electronAPI = {
    send: vi.fn(),
    invoke: mockInvoke,
    on: vi.fn(() => () => {}),
  } as any
})

describe('RecordingControls', () => {
  it('renders start recording button when not recording', () => {
    render(<RecordingControls isRecording={false} onStopRecording={() => {}} onFetchSources={async () => []} />)
    expect(screen.getByText('Record')).toBeInTheDocument()
  })

  it('renders stop button when recording', () => {
    render(<RecordingControls isRecording onStopRecording={() => {}} onFetchSources={async () => []} />)
    expect(screen.getByText('Stop Recording')).toBeInTheDocument()
  })

  it('opens the picker store when Record is clicked', async () => {
    const sources = [
      { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' },
      { id: 'window:2', name: 'Visual Studio Code', thumbnailDataUrl: 'data:image/png;base64,def' },
    ]
    const fetchSources = vi.fn(async () => sources)

    render(
      <RecordingControls
        isRecording={false}
        onStopRecording={() => {}}
        onFetchSources={fetchSources}
      />
    )
    await userEvent.click(screen.getByText('Record'))

    expect(fetchSources).toHaveBeenCalled()
    expect(useRecordingPickerStore.getState()).toMatchObject({
      isOpen: true,
      sources,
      detectedId: 'window:1',
    })
  })
})
