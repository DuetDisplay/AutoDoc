import type { ReactNode } from 'react'

const ICONS = {
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  language: (
    <>
      <path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />
    </>
  ),
  appearance: (
    <>
      <path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </>
  )
}

/** Grouped rows share one rounded container; dividers come from the group. */
export function AnnouncementGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border-subtle rounded-xl border border-border bg-bg-primary">
      {children}
    </div>
  )
}

function RowIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg-card text-ink-secondary"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-[15px]"
      >
        {ICONS[name]}
      </svg>
    </span>
  )
}

/**
 * Icon badge beside a text column. The label and its control share one wrapping line, so a
 * control that does not fit drops under the label (aligned with the text, not the icon).
 */
export function AnnouncementRow({
  icon,
  headingId,
  title,
  control,
  children
}: {
  icon: keyof typeof ICONS
  headingId: string
  title: string
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="flex items-start gap-3 px-4 py-3.5" aria-labelledby={headingId}>
      <RowIcon name={icon} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 id={headingId} className="min-w-0 text-[13px] font-semibold leading-7 text-ink">
            {title}
          </h3>
          {control}
        </div>
        {children}
      </div>
    </section>
  )
}
