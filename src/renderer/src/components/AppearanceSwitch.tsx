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
      className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium leading-snug text-ink-muted hover:bg-bg-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
    >
      <span className="min-w-0 basis-[5rem] grow text-pretty">{t('appearance.darkMode')}</span>
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center gap-1 rounded-full border border-border p-1"
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full ${!dark ? 'bg-sage text-on-brand' : ''}`}
        >
          ☀
        </span>
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full ${dark ? 'bg-sage text-on-brand' : ''}`}
        >
          ☾
        </span>
      </span>
    </button>
  )
}
