import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VideoCaptureWarning } from '../VideoCaptureWarning'

describe('VideoCaptureWarning', () => {
  it('explains that audio continues during the live fallback', () => {
    render(<VideoCaptureWarning variant="live" />)

    expect(screen.getByText('Screen recording stopped')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Audio is still recording. Your transcript and notes will continue to be saved.'
      )
    ).toBeInTheDocument()
  })

  it('explains what was saved on the finished meeting', () => {
    render(<VideoCaptureWarning variant="saved" />)

    expect(screen.getByText('Screen recording ended early')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The screen video may be incomplete. Audio, transcript, and notes were saved.'
      )
    ).toBeInTheDocument()
  })
})
