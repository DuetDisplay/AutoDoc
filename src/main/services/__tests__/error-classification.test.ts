import { describe, expect, it } from 'vitest'
import { classifyError } from '../error-classification'

describe('classifyError', () => {
  it.each([
    ['mlx-whisper exited with code 1: boom', 'whisper-crash'],
    ['mlx-whisper-turbo exited with code null (signal SIGABRT)', 'whisper-metal-crash'],
    [
      'parakeet-mlx exited with code null (signal SIGABRT): [METAL] Command buffer execution failed',
      'whisper-crash'
    ]
  ])('classifies a crashed local speech bridge: %s', (message, expected) => {
    expect(classifyError(message)).toBe(expected)
  })

  it.each([
    'Insufficient free memory for GPU transcription pass (1.7 GiB free, floor 2.5 GiB) after extended wait',
    'Insufficient free memory for GPU transcription pass (1.5 GiB free, floor 2.5 GiB)'
  ])('classifies the memory gate failure: %s', (message) => {
    expect(classifyError(message)).toBe('insufficient-memory')
  })

  it('prefers disk-full over ffmpeg when ffmpeg reports a full disk', () => {
    expect(
      classifyError('ffmpeg exited with code 228: Error writing output: No space left on device')
    ).toBe('disk-full')
    expect(classifyError('ENOSPC: no space left on device, write')).toBe('disk-full')
  })

  it('keeps plain ffmpeg errors and unrelated errors classified as before', () => {
    expect(classifyError('ffmpeg exited with code 1: Invalid data found')).toBe('ffmpeg-error')
    expect(classifyError('something unexpected')).toBe('unknown')
  })
})
