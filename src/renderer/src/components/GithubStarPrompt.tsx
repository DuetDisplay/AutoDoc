import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../services/i18n'

const buttonClass =
  'rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage disabled:opacity-50'

export function GithubStarPrompt({
  suppressed = false,
  ready = true
}: {
  suppressed?: boolean
  ready?: boolean
}) {
  const t = useT()
  const headingId = useId(),
    bodyId = useId()
  const [reservation, setReservation] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [thanks, setThanks] = useState(false)
  const [failed, setFailed] = useState(false)
  const [fading, setFading] = useState(false)
  const [finished, setFinished] = useState(false)
  const element = useRef<HTMLDivElement>(null)
  const active = useRef(false)
  const reservationRef = useRef<string | null>(null)
  const confirmedRef = useRef(false)
  const suppressedRef = useRef(suppressed || !ready)
  const done = useRef(false)
  const thanksRef = useRef(false)
  const leftApp = useRef(false)
  const inFlight = useRef(false)
  const entryChecked = useRef(false)
  suppressedRef.current = suppressed || !ready

  const dismiss = useCallback(() => {
    done.current = true
    setFinished(true)
  }, [])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (reservationRef.current && !confirmedRef.current)
        void window.electronAPI.invoke('github-star:cancel', reservationRef.current).catch(() => {})
    }
  }, [])

  // Check on entering AI Notes or returning to the app, never on generation events or a timer.
  useEffect(() => {
    const reserve = async () => {
      if (
        done.current ||
        inFlight.current ||
        reservationRef.current ||
        suppressedRef.current ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus()
      )
        return
      inFlight.current = true
      try {
        const id = await window.electronAPI.invoke('github-star:reserve')
        if (!id) return
        if (
          !active.current ||
          done.current ||
          suppressedRef.current ||
          !document.hasFocus() ||
          document.visibilityState !== 'visible'
        ) {
          void window.electronAPI.invoke('github-star:cancel', id).catch(() => {})
          return
        }
        reservationRef.current = id
        setReservation(id)
      } catch {
        /* Optional requests fail quietly. */
      } finally {
        inFlight.current = false
      }
    }
    const returned = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        if (thanksRef.current) leftApp.current = true
        return
      }
      if (thanksRef.current && leftApp.current) setFading(true)
      else void reserve()
    }
    if (ready && !entryChecked.current) {
      entryChecked.current = true
      void reserve()
    }
    window.addEventListener('focus', returned)
    window.addEventListener('blur', returned)
    document.addEventListener('visibilitychange', returned)
    return () => {
      window.removeEventListener('focus', returned)
      window.removeEventListener('blur', returned)
      document.removeEventListener('visibilitychange', returned)
    }
  }, [ready, suppressed])

  useEffect(() => {
    if (!reservation || confirmed) return
    let frame2 = 0
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        const rect = element.current?.getBoundingClientRect()
        if (
          !rect ||
          rect.top < 0 ||
          rect.bottom > innerHeight ||
          suppressedRef.current ||
          !document.hasFocus() ||
          document.visibilityState !== 'visible'
        ) {
          void window.electronAPI.invoke('github-star:cancel', reservation).catch(() => {})
          reservationRef.current = null
          if (active.current) setReservation(null)
          return
        }
        void window.electronAPI
          .invoke('github-star:confirm', reservation)
          .then((ok) => {
            if (!active.current) return
            if (ok) {
              confirmedRef.current = true
              setConfirmed(true)
            } else {
              reservationRef.current = null
              setReservation(null)
            }
          })
          .catch(() => {
            if (active.current) {
              reservationRef.current = null
              setReservation(null)
            }
          })
      })
    })
    return () => {
      cancelAnimationFrame(frame1)
      cancelAnimationFrame(frame2)
    }
  }, [reservation, confirmed])

  useEffect(() => {
    if (suppressed && confirmed) queueMicrotask(dismiss)
  }, [suppressed, confirmed, dismiss])
  useEffect(() => {
    if (!fading) return
    const timer = window.setTimeout(
      dismiss,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220
    )
    return () => window.clearTimeout(timer)
  }, [fading, dismiss])

  const open = async () => {
    if (!confirmed || thanksRef.current) return
    thanksRef.current = true
    leftApp.current = false
    setThanks(true)
    setFailed(false)
    try {
      if (await window.electronAPI.invoke('github-star:open')) return
    } catch {
      /* Offer a retry if the browser could not open. */
    }
    thanksRef.current = false
    if (active.current) {
      setThanks(false)
      setFailed(true)
    }
  }

  if (!reservation || finished || suppressed || !ready) return null
  return (
    <div
      ref={element}
      className={`shrink-0 px-6 pt-4 transition-opacity duration-200 motion-reduce:transition-none ${fading ? 'opacity-0' : 'opacity-100'}`}
    >
      <section
        aria-labelledby={headingId}
        aria-describedby={thanks ? undefined : bodyId}
        className="relative rounded-xl border border-border bg-bg-card px-4 py-3.5"
      >
        <button
          type="button"
          aria-label={t('common.dismiss')}
          onClick={dismiss}
          disabled={!confirmed}
          className={`absolute right-2 ${thanks ? 'top-1/2 -translate-y-1/2' : 'top-2'} flex size-8 items-center justify-center rounded-lg text-ink-muted hover:bg-bg-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-sage`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="size-4"
          >
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
        <div className={`flex ${thanks ? 'items-center' : 'items-start'} gap-3 pr-7`}>
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sage-light text-sage-dark"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              className="size-5"
            >
              <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={headingId}
              className="text-[13px] font-semibold tracking-[-0.01em] text-ink"
              aria-live="polite"
            >
              {t(thanks ? 'githubStar.thanks' : 'githubStar.heading')}
            </h2>
            {!thanks && (
              <>
                <p id={bodyId} className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  {t('githubStar.body')}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void open()}
                    disabled={!confirmed}
                    className={`${buttonClass} bg-sage text-on-brand hover:bg-sage-dark`}
                  >
                    <span aria-hidden="true" className="mr-1.5">
                      ★
                    </span>
                    {t('githubStar.star')}
                  </button>
                  <button
                    type="button"
                    onClick={dismiss}
                    disabled={!confirmed}
                    className={`${buttonClass} text-ink-muted hover:bg-bg-accent hover:text-ink`}
                  >
                    {t('githubStar.noThanks')}
                  </button>
                </div>
                {failed && (
                  <p role="alert" className="mt-2 text-[12px] text-clay-dark">
                    {t('githubStar.openFailed')}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
