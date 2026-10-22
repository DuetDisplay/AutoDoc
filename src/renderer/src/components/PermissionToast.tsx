import { useEffect } from 'react'
import { useToastStore } from '../stores/toast'
import { ROUTES } from '../../../shared/constants'
import { useT } from '../services/i18n'

const ICONS: Record<string, string> = {
  screen: '🖥️',
  microphone: '🎤',
  calendar: '📅',
  warning: '⚠️'
}

export function PermissionToast() {
  const t = useT()
  const { activeToast, dismissToast } = useToastStore()
  const message = activeToast?.messageKey ? t(activeToast.messageKey) : activeToast?.message
  const actionLabel = activeToast?.action?.labelKey
    ? t(activeToast.action.labelKey)
    : activeToast?.action?.label

  useEffect(() => {
    if (!activeToast) return
    const timer = setTimeout(dismissToast, 8000)
    return () => clearTimeout(timer)
  }, [activeToast, dismissToast])

  if (!activeToast) return null

  const handleEnable = () => {
    if (!activeToast.action) return

    if (activeToast.action.type === 'navigate') {
      window.location.hash = `#${activeToast.action.target || ROUTES.settings}`
    } else {
      window.electronAPI.invoke(
        'permissions:open-settings',
        activeToast.action.target as 'screen' | 'microphone'
      )
    }
    dismissToast()
  }

  return (
    <div className="mx-6 mt-2 mb-0 bg-bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap items-start gap-3 shadow-sm animate-[slideDown_300ms_ease] min-w-0">
      <span className="text-[16px]">{ICONS[activeToast.type] ?? '⚠️'}</span>
      <span className="text-[12px] text-ink-secondary flex-1 min-w-0 text-pretty">
        {message}
      </span>
      {activeToast.action ? (
        <button
          onClick={handleEnable}
          className="i18n-btn text-[12px] font-semibold text-sage hover:text-sage-dark transition-colors"
        >
          {actionLabel}
        </button>
      ) : null}
      <button
        onClick={dismissToast}
        title={t('common.dismiss')}
        className="text-[16px] text-ink-faint hover:text-ink-muted leading-none transition-colors"
      >
        ×
      </button>
    </div>
  )
}
