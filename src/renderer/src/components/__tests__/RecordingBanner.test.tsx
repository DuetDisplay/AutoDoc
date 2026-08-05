import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecordingBanner } from '../RecordingBanner'

describe('RecordingBanner', () => {
  it('renders nothing when not recording', () => {
    const { container } = render(
      <RecordingBanner
        isRecording={false}
        videoDisabled={false}
        elapsedSeconds={0}
        sourceName={null}
        onStop={() => {}}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders banner with source name and timer', () => {
    render(
      <RecordingBanner
        isRecording
        videoDisabled={false}
        elapsedSeconds={125}
        sourceName="Zoom Meeting"
        onStop={() => {}}
      />
    )
    expect(screen.getByText('Recording')).toBeInTheDocument()
    expect(screen.queryByText('Recording audio only')).not.toBeInTheDocument()
    expect(screen.queryByText('Screen video was interrupted')).not.toBeInTheDocument()
    expect(screen.getByText(/Zoom Meeting/)).toBeInTheDocument()
    expect(screen.getByText('2:05')).toBeInTheDocument()
  })

  it('shows the audio-only recording state without embedding the warning copy', () => {
    render(
      <RecordingBanner
        isRecording
        videoDisabled
        elapsedSeconds={125}
        sourceName="Zoom Meeting"
        onStop={() => {}}
      />
    )

    expect(screen.getByText('Recording audio only')).toBeInTheDocument()
    expect(screen.queryByText('Screen video was interrupted')).not.toBeInTheDocument()
    expect(screen.getByText('Zoom Meeting')).toBeInTheDocument()
    expect(screen.getByText('2:05')).toBeInTheDocument()
  })

  it('calls onStop when stop button clicked', async () => {
    const onStop = vi.fn()
    render(
      <RecordingBanner
        isRecording
        videoDisabled={false}
        elapsedSeconds={10}
        sourceName="Meet"
        onStop={onStop}
      />
    )
    await userEvent.click(screen.getByText('Stop'))
    expect(onStop).toHaveBeenCalled()
  })
})
