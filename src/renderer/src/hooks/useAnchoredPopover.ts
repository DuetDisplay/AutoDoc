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
      const gap = 8
      const viewportBottom = Math.max(0, window.innerHeight - gutter)
      const topInset = Math.min(60, viewportBottom) // Stay below the window's drag region.
      const fittedWidth = Math.max(0, Math.min(width, window.innerWidth - gutter * 2))
      const top = Math.max(topInset, Math.min(anchor.top, viewportBottom))
      const bottom = Math.max(topInset, Math.min(anchor.bottom, viewportBottom))
      const below = Math.max(0, viewportBottom - bottom - gap)
      const above = Math.max(0, top - topInset - gap)
      const openAbove = below < maxHeight && above > below
      // A tall or scrolled-out anchor can leave no room on either side. In that
      // case use the viewport's usable area instead of forcing a clipped 32px menu.
      const available =
        Math.max(above, below) < 32 ? viewportBottom - topInset : openAbove ? above : below
      const fittedHeight = Math.min(maxHeight, viewportBottom - topInset, available)
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
        maxHeight: fittedHeight,
        ...(openAbove
          ? { bottom: window.innerHeight - Math.max(topInset + fittedHeight, top - gap) }
          : { top: Math.max(topInset, Math.min(bottom + gap, viewportBottom - fittedHeight)) })
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
