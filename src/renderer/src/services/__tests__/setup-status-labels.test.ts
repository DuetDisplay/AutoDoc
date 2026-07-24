import { describe, expect, it } from 'vitest'
import { getOllamaSetupLabel } from '../setup-status-labels'

describe('getOllamaSetupLabel', () => {
  it('labels notes model pulls separately from Ask AI embedding pulls', () => {
    expect(getOllamaSetupLabel({ phase: 'pulling', percent: 42, pullModel: 'llama3.1' })).toBe(
      'Downloading notes model... 42%'
    )
    expect(
      getOllamaSetupLabel({ phase: 'pulling', percent: 0, pullModel: 'qwen3-embedding:0.6b' })
    ).toBe('Preparing Ask AI search model...')
  })

  it('defaults pulling label to notes model when pullModel is missing', () => {
    expect(getOllamaSetupLabel({ phase: 'pulling', percent: 15 })).toBe(
      'Downloading notes model... 15%'
    )
    expect(getOllamaSetupLabel({ phase: 'pulling', percent: 0 })).toBe('Preparing notes model...')
  })
})
