import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AskAiIndexStatus } from '../../../shared/ask-ai-index-status'
import { useI18n } from '../services/i18n'

const idle: AskAiIndexStatus = { state: 'idle', percent: 0, significant: false }

export function AskAiIndexNotice(): ReactElement {
  const { t } = useI18n()
  const [status, setStatus] = useState(idle)
  const [visible, setVisible] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const latest = useRef(status)
  latest.current = status
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

  const copyState = status.percent === 0 ? 'starting' : status.state
  const copyKey =
    copyState === 'starting'
      ? 'askAi.indexingStarting'
      : copyState === 'paused'
        ? 'askAi.indexingPaused'
        : 'askAi.indexingProgress'
  // Only state changes update the live region. The visible paragraph separately
  // exposes the current percentage to assistive technology.
  useEffect(() => {
    setAnnouncement(
      shown
        ? t(copyKey, {
            percent: latest.current.percent
          })
        : ''
    )
  }, [shown, copyState, t])

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
          <p className="rounded-xl border border-border bg-bg-accent px-3 py-2 text-[12px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
            {t(copyKey, {
              percent: status.percent
            })}
          </p>
        </div>
      )}
    </div>
  )
}
