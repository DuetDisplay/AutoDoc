import { useEffect, useMemo, useState } from 'react'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../../../shared/ui-language'

/** Decorative greetings, one per UI language. Intentionally not part of the i18n catalog. */
const GREETINGS: Record<UiLanguageCode, string> = {
  en: 'Hello',
  bg: 'Здравейте',
  hr: 'Bok',
  cs: 'Ahoj',
  da: 'Hej',
  nl: 'Hallo',
  et: 'Tere',
  fi: 'Hei',
  fr: 'Bonjour',
  de: 'Hallo',
  el: 'Γεια σας',
  hu: 'Szia',
  it: 'Ciao',
  lv: 'Sveiki',
  lt: 'Labas',
  pl: 'Cześć',
  pt: 'Olá',
  ro: 'Bună',
  ru: 'Привет',
  sk: 'Ahoj',
  sl: 'Živjo',
  es: 'Hola',
  sv: 'Hej',
  uk: 'Привіт',
  ja: 'こんにちは',
  'zh-Hans': '你好',
  ko: '안녕하세요'
}

const ROTATE_MS = 2400

/** The current language first, then the others in catalog order, skipping repeated words. */
function greetingRotation(
  language: UiLanguageCode
): Array<{ language: UiLanguageCode; text: string }> {
  const seen = new Set<string>()
  const ordered = [language, ...UI_LANGUAGE_CODES.filter((code) => code !== language)]
  return ordered.flatMap((code) => {
    const text = GREETINGS[code]
    if (seen.has(text)) return []
    seen.add(text)
    return [{ language: code, text }]
  })
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  )
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return reduced
}

/** Purely decorative crossfading hello. Rotates only while `active`, and restarts per language. */
export function AnnouncementGreeting({
  language,
  active
}: {
  language: UiLanguageCode
  active: boolean
}) {
  const reduced = useReducedMotion()
  const greetings = useMemo(() => greetingRotation(language), [language])
  // The step belongs to a language, so choosing another one restarts at its own greeting.
  const [step, setStep] = useState({ language, index: 0 })
  const index = step.language === language ? step.index : 0
  useEffect(() => {
    if (!active || reduced) return
    const timer = window.setInterval(
      () =>
        setStep((current) => ({
          language,
          index: (current.language === language ? current.index : 0) + 1
        })),
      ROTATE_MS
    )
    return () => window.clearInterval(timer)
  }, [active, reduced, language])
  const shown = reduced ? 0 : index % greetings.length
  return (
    <div
      aria-hidden="true"
      data-announcement-greeting
      className="relative mt-2 h-10 w-full overflow-hidden"
    >
      {greetings.map((greeting, position) =>
        reduced && position !== 0 ? null : (
          <span
            key={greeting.language}
            lang={greeting.language}
            data-greeting-visible={position === shown ? '' : undefined}
            className={`absolute inset-0 flex items-center justify-center whitespace-nowrap font-sans text-[28px] font-bold leading-10 tracking-[-0.03em] text-ink transition-opacity duration-700 ease-in-out motion-reduce:transition-none ${position === shown ? 'opacity-100' : 'opacity-0'}`}
          >
            {greeting.text}
          </span>
        )
      )}
    </div>
  )
}
