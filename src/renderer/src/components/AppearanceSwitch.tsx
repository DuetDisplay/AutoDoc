import { useT } from '../services/i18n'
import { useAppearance } from '../services/theme'

/** Shares the same live preference as the Settings appearance buttons. */
export function AppearanceSwitch() {
  const t = useT()
  const { appearance, setAppearance } = useAppearance()
  const dark = appearance === 'dark'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={t('appearance.darkMode')}
      onClick={() => void setAppearance(dark ? 'light' : 'dark')}
      className="relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-border p-[5px] text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card"
    >
      <span
        aria-hidden="true"
        data-appearance-thumb
        className={`absolute left-[5px] top-[5px] size-5 rounded-full bg-sage transition-transform duration-200 ease-out motion-reduce:transition-none ${dark ? 'translate-x-6' : 'translate-x-0'}`}
      />
      <span aria-hidden="true" className="relative flex w-full items-center justify-between">
        <span
          className={`flex size-5 items-center justify-center transition-colors duration-200 motion-reduce:transition-none ${!dark ? 'text-on-brand' : ''}`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="size-3.5"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </svg>
        </span>
        <span
          className={`flex size-5 items-center justify-center transition-colors duration-200 motion-reduce:transition-none ${dark ? 'text-on-brand' : ''}`}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5">
            <path d="M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z" />
          </svg>
        </span>
      </span>
    </button>
  )
}
