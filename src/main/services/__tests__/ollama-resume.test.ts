import { afterEach, describe, expect, it } from 'vitest'
import {
  getMsSinceLastResume,
  markOllamaResumed,
  resetOllamaResumeClock
} from '../ollama-resume'

afterEach(() => {
  resetOllamaResumeClock()
})

describe('ollama resume clock', () => {
  it('is null until a resume is recorded', () => {
    expect(getMsSinceLastResume(1_000)).toBeNull()
  })

  it('reports milliseconds since the last resume', () => {
    markOllamaResumed(1_000)
    expect(getMsSinceLastResume(4_250)).toBe(3_250)
  })
})
