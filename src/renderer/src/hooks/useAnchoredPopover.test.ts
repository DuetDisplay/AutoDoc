import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnchoredPopover } from './useAnchoredPopover'

afterEach(() => vi.unstubAllGlobals())

describe('anchored popover viewport bounds', () => {
  it.each([
    ['near the bottom', 230, 20],
    ['near the top', 60, 20],
    ['across the viewport', -400, 1200],
    ['below the viewport', 800, 20],
    ['above the viewport', -100, 20]
  ])(
    'keeps its full maximum height inside the usable viewport with an anchor %s',
    (_name, y, height) => {
      vi.stubGlobal('innerWidth', 394)
      vi.stubGlobal('innerHeight', 270)
      const anchor = document.createElement('button')
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(340, Number(y), 50, Number(height))
      )
      const { result } = renderHook(() => useAnchoredPopover(true, { current: anchor }, 224, 320))
      const style = result.current
      const maximumHeight = Number(style.maxHeight)
      const top =
        style.top === undefined ? 270 - Number(style.bottom) - maximumHeight : Number(style.top)
      expect(top).toBeGreaterThanOrEqual(60)
      expect(top + maximumHeight).toBeLessThanOrEqual(254)
      expect(maximumHeight).toBeGreaterThanOrEqual(32)
      expect(Number(style.left)).toBeGreaterThanOrEqual(16)
      expect(Number(style.left) + Number(style.width)).toBeLessThanOrEqual(378)
    }
  )

  it('repositions above or below a moving trigger on scroll and resize', () => {
    vi.stubGlobal('innerWidth', 394)
    vi.stubGlobal('innerHeight', 270)
    const anchor = document.createElement('button')
    const measure = vi
      .spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(20, 70, 40, 20))
    const ref = { current: anchor }
    const { result } = renderHook(() => useAnchoredPopover(true, ref, 224, 320, 'start'))
    expect(result.current.top).toBe(98)
    expect(result.current.bottom).toBeUndefined()
    measure.mockReturnValue(new DOMRect(20, 230, 40, 20))
    act(() => window.dispatchEvent(new Event('scroll')))
    expect(result.current.top).toBeUndefined()
    expect(result.current.bottom).toBe(48)
    vi.stubGlobal('innerHeight', 600)
    act(() => window.dispatchEvent(new Event('resize')))
    expect(result.current.top).toBe(258)
    expect(result.current.bottom).toBeUndefined()
  })
})
