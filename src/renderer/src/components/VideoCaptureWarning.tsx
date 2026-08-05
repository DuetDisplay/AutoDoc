import type { JSX } from 'react'

interface VideoCaptureWarningProps {
  variant: 'live' | 'saved'
}

const COPY = {
  live: {
    title: 'Screen recording stopped',
    body: 'Audio is still recording. Your transcript and notes will continue to be saved.'
  },
  saved: {
    title: 'Screen recording ended early',
    body: 'The screen video may be incomplete. Audio, transcript, and notes were saved.'
  }
} as const

export function VideoCaptureWarning({ variant }: VideoCaptureWarningProps): JSX.Element {
  const copy = COPY[variant]

  return (
    <div className="flex items-start gap-3 rounded-xl border border-clay/30 bg-clay-light px-4 py-3.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-clay/15 text-clay-dark">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5" />
          <path d="M12 16.5h.01" />
        </svg>
      </div>
      <div className="min-w-0 pt-0.5">
        <p className="text-[12px] font-semibold text-ink">{copy.title}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-clay-dark">{copy.body}</p>
      </div>
    </div>
  )
}
