import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 py-5 border-b border-border min-w-0">
      <div className="min-w-0 flex-[1_1_12rem]">
        <h1 className="text-[18px] font-bold text-ink tracking-[-0.03em] text-pretty [overflow-wrap:anywhere]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[12px] text-ink-faint mt-0.5 text-pretty [overflow-wrap:anywhere]">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="min-w-0 max-w-full">{action}</div>}
    </div>
  )
}
