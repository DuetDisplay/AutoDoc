import { describe, expect, it } from 'vitest'
import { isDiskFullError } from '../disk-full'

describe('isDiskFullError', () => {
  it('matches ENOSPC and EDQUOT error codes', () => {
    expect(isDiskFullError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true)
    expect(isDiskFullError(Object.assign(new Error('write failed'), { code: 'EDQUOT' }))).toBe(true)
  })

  it('matches the common OS and tool wording in messages and plain strings', () => {
    expect(isDiskFullError(new Error('ENOSPC: no space left on device, write'))).toBe(true)
    expect(
      isDiskFullError(
        'ffmpeg merge exited with code 228: av_interleaved_write_frame(): No space left on device'
      )
    ).toBe(true)
    expect(isDiskFullError('ditto: /Applications/AutoDoc.app: No space left on device')).toBe(true)
    expect(isDiskFullError(new Error('There is not enough space on the disk.'))).toBe(true)
    expect(isDiskFullError(new Error('Disk quota exceeded'))).toBe(true)
    expect(isDiskFullError(new Error('Disk is full.'))).toBe(true)
    expect(isDiskFullError(new Error('Not enough disk space.'))).toBe(true)
    expect(isDiskFullError(new Error('Not enough space on disk.'))).toBe(true)
  })

  it('follows cause chains', () => {
    const inner = Object.assign(new Error('write'), { code: 'ENOSPC' })
    expect(isDiskFullError(new Error('outer failure', { cause: inner }))).toBe(true)
  })

  it('does not flag unrelated errors or empty values', () => {
    expect(isDiskFullError(new Error('ffmpeg exited with code 1: encode error'))).toBe(false)
    expect(isDiskFullError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false)
    expect(isDiskFullError('404 Not Found')).toBe(false)
    expect(isDiskFullError(new Error('Not enough memory to load the model'))).toBe(false)
    expect(isDiskFullError(undefined)).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
    expect(isDiskFullError(42)).toBe(false)
  })
})
