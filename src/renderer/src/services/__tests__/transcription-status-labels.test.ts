import { describe, expect, it } from 'vitest'
import { formatTranscriptionStatusText } from '../transcription-status-labels'

describe('formatTranscriptionStatusText', () => {
  it('formats GPU balanced status with ETA', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        progress: 42,
        backendLabel: 'GPU accelerated transcription',
        qualityMode: 'balanced',
        etaSeconds: 240
      })
    ).toBe('Transcribing on GPU (Balanced) — about 4 minutes left')
  })

  it('uses less than a minute copy for short ETAs', () => {
    expect(
      formatTranscriptionStatusText({
        status: 'transcribing',
        progress: 80,
        backendLabel: 'CPU optimized transcription',
        qualityMode: 'fast',
        etaSeconds: 45
      })
    ).toBe('Transcribing on CPU (Fast) — less than a minute left')
  })
})
