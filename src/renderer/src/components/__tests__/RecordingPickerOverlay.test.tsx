import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingPickerOverlay } from '../RecordingPickerOverlay'
import { useRecordingPickerStore } from '../../stores/recording-picker'

describe('RecordingPickerOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRecordingPickerStore.getState().closePicker()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <RecordingPickerOverlay onStartRecording={vi.fn(async () => {})} />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('starts recording with the picker selection context', async () => {
    const onStartRecording = vi.fn(async () => {})
    useRecordingPickerStore.getState().openPicker({
      title: 'Select the meeting window',
      sources: [
        { id: 'window:1', name: 'Zoom Meeting', thumbnailDataUrl: 'data:image/png;base64,abc' },
      ],
      detectedId: 'window:1',
      selectionContext: {
        eventId: 'evt-1',
        recurringEventId: null,
        providerHint: 'zoom',
      },
    })

    render(<RecordingPickerOverlay onStartRecording={onStartRecording} />)

    await userEvent.click(screen.getByRole('button', { name: /zoom meeting/i }))

    await waitFor(() => {
      expect(onStartRecording).toHaveBeenCalledWith('window:1', 'Zoom Meeting', {
        eventId: 'evt-1',
        recurringEventId: null,
        providerHint: 'zoom',
      })
    })
    expect(useRecordingPickerStore.getState().isOpen).toBe(false)
  })
})
