import { describe, expect, it } from 'vitest'
import { computeRealtimeFactor } from '../transcription-metrics'

describe('transcription metrics', () => {
  it('computes realtime factor from audio duration and wall time', () => {
    expect(computeRealtimeFactor(120, 60)).toBe(2)
    expect(computeRealtimeFactor(90, 120)).toBe(0.75)
  })

  it('returns null for invalid inputs', () => {
    expect(computeRealtimeFactor(0, 60)).toBeNull()
    expect(computeRealtimeFactor(60, 0)).toBeNull()
  })
})
