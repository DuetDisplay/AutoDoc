import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useT } from '../services/i18n'
import { useAppearance } from '../services/theme'

type Mode = 'light' | 'dark'

// Miniature app screenshots depict each theme, so their colours are fixed on purpose.
const MINI = {
  light: { bg: '#fafaf7', side: '#ecebe4', bar: '#4a6b4e', line: '#d6d4ca' },
  dark: { bg: '#1c1c18', side: '#121210', bar: '#8fb392', line: '#46453d' }
} as const

function MiniApp({ mode }: { mode: Mode }) {
  const c = MINI[mode]
  return (
    <span
      aria-hidden="true"
      className="flex h-[68px] w-full overflow-hidden rounded-md"
      style={{ backgroundColor: c.bg }}
    >
      <span className="w-[24%]" style={{ backgroundColor: c.side }} />
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2 w-2/3 rounded-sm" style={{ backgroundColor: c.bar }} />
        <span className="h-1.5 w-full rounded-sm" style={{ backgroundColor: c.line }} />
        <span className="h-1.5 w-4/5 rounded-sm" style={{ backgroundColor: c.line }} />
      </span>
    </span>
  )
}

/** Two preview cards that drive the same live preference as the sidebar switch. */
export function AppearancePreviewChoice({ labelledBy }: { labelledBy: string }) {
  const t = useT()
  const { appearance, setAppearance } = useAppearance()
  const refs = useRef<Record<Mode, HTMLButtonElement | null>>({ light: null, dark: null })
  const modes: Mode[] = ['light', 'dark']
  const onKeyDown = (event: KeyboardEvent, mode: Mode) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next: Mode = mode === 'light' ? 'dark' : 'light'
    refs.current[next]?.focus()
    void setAppearance(next)
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="mt-3 grid grid-cols-2 gap-3">
      {modes.map((mode) => {
        const selected = appearance === mode
        return (
          <button
            key={mode}
            ref={(node) => {
              refs.current[mode] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            data-appearance-choice={mode}
            onClick={() => void setAppearance(mode)}
            onKeyDown={(event) => onKeyDown(event, mode)}
            className={`flex min-w-0 flex-col gap-2 rounded-lg bg-bg-card p-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage ${selected ? 'border-2 border-sage' : 'm-px border border-border'}`}
          >
            <MiniApp mode={mode} />
            <span
              className={`px-1 pb-0.5 text-[13px] leading-snug text-ink [overflow-wrap:anywhere] ${selected ? 'font-semibold' : 'font-medium'}`}
            >
              {t(mode === 'light' ? 'appearance.light' : 'appearance.dark')}
            </span>
          </button>
        )
      })}
    </div>
  )
}
