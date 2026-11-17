import { useEffect, useState, type ReactElement } from 'react'
import type { AskAiIndexStatus } from '../../../shared/ask-ai-index-status'
import { useI18n } from '../services/i18n'

const idle: AskAiIndexStatus = { state: 'idle', percent: 0, significant: false }

export function AskAiIndexNotice(): ReactElement {
  const { t } = useI18n()
  const [status, setStatus] = useState(idle)
  const [visible, setVisible] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const candidate =
    status.significant && (status.state === 'preparing' || status.state === 'paused')
  const shown = candidate && visible

  useEffect(() => {
    let active = true
    let pushed = false
    const unsubscribe = window.electronAPI.on('chat:index-status-changed', (next) => {
      pushed = true
      if (active) setStatus(next)
    })
    void window.electronAPI.invoke('chat:index-status').then(
      (initial) => {
        if (active && !pushed) setStatus(initial ?? idle)
      },
      () => {}
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!candidate) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), 2000)
    return () => window.clearTimeout(timer)
  }, [candidate])

  // At zero there is nothing to report yet: starting copy, the bar at its minimum, no number.
  const showPercent = status.percent > 0
  const paused = status.state === 'paused' && showPercent
  const title = t(paused ? 'askAi.indexingPausedTitle' : 'askAi.indexingTitle')
  // Only state changes update the live region. The visible progress bar separately
  // exposes the current percentage to assistive technology.
  useEffect(() => {
    setAnnouncement(
      shown
        ? t(
            status.state === 'paused'
              ? 'askAi.indexingPausedAnnouncement'
              : 'askAi.indexingPreparingAnnouncement'
          )
        : ''
    )
  }, [shown, status.state, t])

  return (
    <div>
      <span
        role={shown ? 'status' : undefined}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-ask-ai-index-announcement
      >
        {announcement}
      </span>
      {shown && (
        <div className="px-6 pt-3 pb-3" data-ask-ai-index-banner data-index-state={status.state}>
          <div className="rounded-xl border border-border bg-bg-accent px-3 py-2.5 text-ink-muted">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-[12.5px] font-semibold text-ink [overflow-wrap:anywhere]">
                {title}
              </p>
              {showPercent && (
                <span className="shrink-0 text-[12px] tabular-nums">
                  {t('askAi.indexingPercent', { percent: status.percent })}
                </span>
              )}
            </div>
            <div
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-label={title}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={status.percent}
            >
              <div
                className={`h-full rounded-full ${paused ? 'bg-control-track-off' : 'bg-sage transition-[width] duration-300'}`}
                style={{ width: `${Math.max(4, Math.min(100, status.percent))}%` }}
              />
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed [overflow-wrap:anywhere]">
              {t(paused ? 'askAi.indexingPausedHelp' : 'askAi.indexingHelp')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
