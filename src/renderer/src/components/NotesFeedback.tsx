import { useEffect, useId, useRef, useState } from 'react'
import {
  NOTES_FEEDBACK_COMMENT_LIMIT,
  NOTES_FEEDBACK_RATINGS,
  type NotesFeedbackRating,
  type NotesFeedbackState
} from '../../../shared/notes-feedback'

const LABELS = { useful: 'Useful', somewhat_useful: 'Somewhat useful', not_useful: 'Not useful' }

export function NotesFeedback({
  meetingId,
  generationId
}: {
  meetingId: string
  generationId: string
}): React.JSX.Element | null {
  const [state, setState] = useState<NotesFeedbackState | null>(null)
  const [rating, setRating] = useState<NotesFeedbackRating | null>(null)
  const [detail, setDetail] = useState(false)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState(false)
  const [success, setSuccess] = useState<'sent' | 'already-sent' | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const successRef = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const id = useId()

  useEffect(() => {
    mounted.current = true
    let active = true
    void window.electronAPI
      .invoke('notes-feedback:state', meetingId, generationId)
      .then((value) => {
        if (!active || !value) return
        setState(value)
        if (value.pending) {
          setRating(value.pending.rating)
          setComment(value.pending.comment)
          setDetail(!!value.pending.comment)
          setAttempted(true)
          setError(true)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      mounted.current = false
    }
  }, [meetingId, generationId])

  useEffect(() => {
    if (detail) textarea.current?.focus()
  }, [detail])
  useEffect(() => {
    if (success) successRef.current?.focus()
  }, [success])

  if (!state?.available) return null
  if (state.sent && !success) {
    return (
      <div className="mx-auto mt-7 w-full max-w-[560px] border-t border-border pt-4 text-[12px] text-ink-muted">
        ✓ Feedback sent
      </div>
    )
  }

  async function send(): Promise<void> {
    if (!rating || inFlight.current) return
    inFlight.current = true
    setSending(true)
    setAttempted(true)
    setError(false)
    try {
      const result = await window.electronAPI.invoke('notes-feedback:send', {
        meetingId,
        generationId,
        rating,
        comment: detail ? comment : ''
      })
      if (!mounted.current) return
      if (result.status === 'failed') {
        setError(true)
        return
      }
      setState({ available: true, sent: true, analyticsEnabled: result.analyticsEnabled })
      setSuccess(result.status)
      setComment('')
    } catch {
      if (mounted.current) setError(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setSending(false)
    }
  }

  return (
    <section
      aria-label="Notes feedback"
      className="mx-auto mt-8 w-full max-w-[560px] border-t border-border pt-5 text-[12.5px] text-ink"
    >
      {success ? (
        <div ref={successRef} tabIndex={-1} role="status" className="outline-none">
          <p className="font-semibold">
            <span className="mr-2 text-sage-dark" aria-hidden="true">
              ✓
            </span>
            Thanks. Your feedback helps improve future notes.
          </p>
          <p className="mt-1 text-ink-muted">
            {success === 'already-sent'
              ? 'Your earlier feedback was already received.'
              : 'Feedback sent.'}
            {!state.analyticsEnabled && ' Analytics is still off.'}
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          aria-busy={sending}
        >
          <fieldset disabled={sending || attempted}>
            <legend className="mb-3 font-semibold">How useful were these notes?</legend>
            <div className="flex flex-wrap gap-2">
              {NOTES_FEEDBACK_RATINGS.map((value) => (
                <label key={value} className="relative cursor-pointer">
                  <input
                    type="radio"
                    name={`${id}-rating`}
                    value={value}
                    checked={rating === value}
                    onChange={() => {
                      setRating(value)
                      setError(false)
                    }}
                    className="peer sr-only"
                  />
                  <span className="block rounded-lg border border-border px-3 py-2 text-ink-secondary transition-colors peer-checked:border-sage peer-checked:bg-sage-light peer-checked:text-sage-dark peer-focus-visible:ring-2 peer-focus-visible:ring-sage peer-focus-visible:ring-offset-2 peer-disabled:opacity-60">
                    {LABELS[value]}
                  </span>
                </label>
              ))}
            </div>
            {detail && rating && (
              <div className="mt-4">
                <label htmlFor={`${id}-comment`} className="mb-2 block font-medium">
                  {rating === 'useful'
                    ? 'What worked well?'
                    : 'What would make these notes more useful?'}{' '}
                  <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <textarea
                  ref={textarea}
                  id={`${id}-comment`}
                  rows={3}
                  value={comment}
                  maxLength={NOTES_FEEDBACK_COMMENT_LIMIT}
                  onChange={(event) => setComment(event.target.value)}
                  aria-describedby={`${id}-hint`}
                  className="w-full resize-y rounded-lg border border-border bg-bg-card p-3 text-ink outline-none focus:border-sage focus:ring-1 focus:ring-sage"
                />
                <div
                  id={`${id}-hint`}
                  className="mt-1 flex justify-between gap-2 text-[11px] text-ink-muted"
                >
                  <span>Avoid including private meeting details.</span>
                  <span>
                    {comment.length}/{NOTES_FEEDBACK_COMMENT_LIMIT}
                  </span>
                </div>
              </div>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="mt-3 text-clay">
              Couldn’t send your feedback. Your response is still here. Check your connection and
              try again.
            </p>
          )}
          {rating && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={sending}
                className="rounded-lg bg-sage-dark px-4 py-2 font-semibold text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
              >
                {sending
                  ? 'Sending…'
                  : error
                    ? 'Try again'
                    : detail
                      ? 'Send feedback'
                      : 'Send rating'}
              </button>
              {!detail && !attempted && (
                <button
                  type="button"
                  onClick={() => setDetail(true)}
                  className="text-ink-secondary underline decoration-border underline-offset-4"
                >
                  Add detail (optional)
                </button>
              )}
              {!attempted && (
                <button
                  type="button"
                  onClick={() => {
                    setRating(null)
                    setDetail(false)
                    setComment('')
                    setError(false)
                  }}
                  className="text-ink-muted"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </form>
      )}
      <div className="mt-4 rounded-lg bg-bg-accent p-3 text-[11.5px] leading-relaxed text-ink-muted">
        <p className="mb-1 font-semibold text-ink-secondary">What gets sent to AutoDoc</p>
        <p>
          Your rating, any comment you add, app version, operating system, and notes engine version.
        </p>
        <p className="mt-1">
          Notes, transcripts, recordings, logs, and meeting titles are not attached.
        </p>
      </div>
      {!state.analyticsEnabled && (
        <p className="mt-2 text-[11.5px] font-medium text-ink-secondary">
          Analytics is off and will stay off.
        </p>
      )}
    </section>
  )
}
