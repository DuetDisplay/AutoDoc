import { describe, expect, it } from 'vitest'
import { formatTranscriptionStatusText } from '../transcription-status-labels'

describe('formatTranscriptionStatusText', () => {
  it('formats transcribing status with progress only (no ETA copy)', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        progress: 42
      })
    ).toBe('Transcribing 42%')
  })

  it('omits progress when it is unknown', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing'
      })
    ).toBe('Transcribing...')
  })

  it('returns null for non-transcribing statuses', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'completed',
        progress: 100
      })
    ).toBeNull()
  })
})
