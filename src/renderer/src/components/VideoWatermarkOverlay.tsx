import type { ReactElement } from 'react'

export function VideoWatermarkOverlay(): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-12 right-3 z-10 rounded-md border border-white/20 bg-ink/65 px-2.5 py-1 text-[10px] font-medium tracking-[0.01em] text-white/90 shadow-sm"
    >
      Meeting notes by <span className="font-serif text-[11px]">AutoDoc</span>
    </div>
  )
}
