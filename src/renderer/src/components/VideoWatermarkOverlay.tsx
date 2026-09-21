import { forwardRef, type ReactElement } from 'react'

export const VideoWatermarkOverlay = forwardRef<HTMLDivElement>(
  function VideoWatermarkOverlay(_props, ref): ReactElement {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-3 z-10 flex select-none items-center gap-1.5 rounded-md border border-white/5 bg-ink/15 px-2 py-1 text-[10px] font-medium tracking-[0.01em] text-white/45 shadow-[0_1px_4px_rgba(0,0,0,0.08)] backdrop-blur-[2px] [&:popover-open]:fixed [&:popover-open]:bottom-auto [&:popover-open]:left-auto [&:popover-open]:m-0"
      >
        <svg
          viewBox="0 0 16 14"
          fill="currentColor"
          className="h-3 w-3.5 shrink-0 text-sage-light/50"
        >
          <rect x="0" y="4" width="2" height="6" rx="1" />
          <rect x="4.5" y="1" width="2" height="12" rx="1" />
          <rect x="9" y="2.5" width="2" height="9" rx="1" />
          <rect x="13.5" y="5" width="2" height="4" rx="1" />
        </svg>
        <span>
          Meeting notes by <span className="font-serif text-[11.5px]">AutoDoc</span>
        </span>
      </div>
    )
  }
)
