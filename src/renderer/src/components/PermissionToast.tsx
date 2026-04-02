import { useEffect } from 'react'
import { useToastStore } from '../stores/toast'
import { ROUTES } from '../../../shared/constants'

const ICONS: Record<string, string> = {
  screen: '🖥️',
  microphone: '🎤',
  calendar: '📅',
}

export function PermissionToast() {
  const { activeToast, dismissToast } = useToastStore()

  useEffect(() => {
    if (!activeToast) return
    const timer = setTimeout(dismissToast, 8000)
    return () => clearTimeout(timer)
  }, [activeToast, dismissToast])

  if (!activeToast) return null

  const handleEnable = () => {
    if (activeToast.type === 'calendar') {
      window.location.hash = `#${ROUTES.settings}`
    } else {
      window.electronAPI.invoke('permissions:open-settings', activeToast.type as 'screen' | 'microphone')
    }
  }

  return (
    <div className="mx-6 mt-2 mb-0 bg-bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm animate-[slideDown_300ms_ease]">
      <span className="text-[16px]">{ICONS[activeToast.type] ?? '⚠️'}</span>
      <span className="text-[12px] text-ink-secondary flex-1">{activeToast.message}</span>
      <button
        onClick={handleEnable}
        className="text-[12px] font-semibold text-sage hover:text-sage-dark whitespace-nowrap transition-colors"
      >
        Enable
      </button>
      <button
        onClick={dismissToast}
        title="Dismiss"
        className="text-[16px] text-ink-faint hover:text-ink-muted leading-none transition-colors"
      >
        ×
      </button>
    </div>
  )
}
