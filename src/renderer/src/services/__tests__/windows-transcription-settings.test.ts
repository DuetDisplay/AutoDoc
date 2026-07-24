import { describe, expect, it } from 'vitest'
import { supportsWindowsTranscriptionQualityFastMode } from '../../../../shared/windows-transcription-settings'

describe('supportsWindowsTranscriptionQualityFastMode', () => {
  it('enables quality fast mode only for Parakeet GPU', () => {
    expect(supportsWindowsTranscriptionQualityFastMode('parakeet-gpu')).toBe(true)
    expect(supportsWindowsTranscriptionQualityFastMode('parakeet-cpu')).toBe(false)
    expect(supportsWindowsTranscriptionQualityFastMode('faster-whisper-cuda')).toBe(false)
    expect(supportsWindowsTranscriptionQualityFastMode(undefined)).toBe(false)
  })
})
