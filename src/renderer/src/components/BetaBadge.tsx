import type { ReactElement } from 'react'
import { useI18n } from '../services/i18n'

// The gradient ring is a decorative pseudo-element (see .beta-badge in main.css); the text is the name.
export function BetaBadge({ className = '' }: { className?: string }): ReactElement {
  const { t } = useI18n()
  return (
    <span
      data-beta-badge
      className={`beta-badge inline-block shrink-0 whitespace-nowrap rounded-full px-[7px] py-px align-middle text-[9.5px] font-semibold leading-[1.45] tracking-[0.04em] ${className}`}
    >
      {t('askAi.beta')}
    </span>
  )
}
