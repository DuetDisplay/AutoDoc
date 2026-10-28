import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Position a body-level popover without clipping it to a scrolling panel. */
export function useAnchoredPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  width: number,
  maxHeight: number,
  align: 'start' | 'end' = 'end'
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (!anchor) return
      const gutter = 16
      const topInset = 60 // Keep controls below the window's drag region.
      const fittedWidth = Math.min(width, window.innerWidth - gutter * 2)
      const top = Math.max(topInset, Math.min(anchor.top, window.innerHeight - gutter))
      const bottom = Math.max(topInset, Math.min(anchor.bottom, window.innerHeight - gutter))
      const below = window.innerHeight - bottom - gutter
      const above = top - topInset - 8
      const openAbove = below < maxHeight && above > below
      const next: CSSProperties = {
        position: 'fixed',
        width: fittedWidth,
        left: Math.max(
          gutter,
          Math.min(
            align === 'start' ? anchor.left : anchor.right - fittedWidth,
            window.innerWidth - fittedWidth - gutter
          )
        ),
        maxHeight: Math.max(32, Math.min(maxHeight, openAbove ? above : below)),
        ...(openAbove ? { bottom: window.innerHeight - top + 8 } : { top: bottom + 8 })
      }
      setStyle((previous) =>
        Object.entries(next).every(
          ([key, value]) => previous[key as keyof CSSProperties] === value
        ) && Object.keys(previous).length === Object.keys(next).length
          ? previous
          : next
      )
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [open, anchorRef, width, maxHeight, align])

  return style
}
