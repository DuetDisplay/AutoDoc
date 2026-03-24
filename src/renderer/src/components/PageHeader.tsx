import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex justify-between items-baseline px-6 py-5 border-b border-border">
      <div>
        <h1 className="text-[18px] font-bold text-ink tracking-[-0.03em]">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[12px] text-ink-faint mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
