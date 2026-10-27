import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_MODES,
  DEFAULT_APPEARANCE,
  isAppearanceMode,
  normalizeAppearance
} from './appearance'

describe('explicit appearance preferences', () => {
  it('offers only Light and Dark, with Light as the default', () => {
    expect(APPEARANCE_MODES).toEqual(['light', 'dark'])
    expect(DEFAULT_APPEARANCE).toBe('light')
  })

  it.each(['auto', 'system', null, undefined, '', 'invalid'])(
    'retires legacy or invalid %s preferences to Light',
    (value) => {
      expect(isAppearanceMode(value)).toBe(false)
      expect(normalizeAppearance(value)).toBe('light')
    }
  )

  it.each(['light', 'dark'] as const)('preserves a saved %s choice', (value) => {
    expect(isAppearanceMode(value)).toBe(true)
    expect(normalizeAppearance(value)).toBe(value)
  })
})
