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
})
