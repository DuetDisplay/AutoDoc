import { describe, expect, it } from 'vitest'
import { formatTranscriptionStatusText } from '../transcription-status-labels'

describe('formatTranscriptionStatusText', () => {
  it('formats transcribing status with progress and ETA', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        progress: 42,
        etaSeconds: 240
      })
    ).toBe('Transcribing 42% — about 4 minutes left')
  })

  it('uses less than a minute copy for short ETAs', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        progress: 80,
        etaSeconds: 45
      })
    ).toBe('Transcribing 80% — less than a minute left')
  })

  it('omits progress when it is unknown', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        etaSeconds: 120
      })
    ).toBe('Transcribing... — about 2 minutes left')
  })
})
