import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { translate, type MessageKey } from '../../../shared/i18n'
import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
  type UiLanguageCode
} from '../../../shared/ui-language'
import { applyDocumentLanguage, readCachedUiLanguage } from './document-language'

type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string

interface I18nContextValue {
  language: UiLanguageCode
  t: TranslateFn
  setLanguage: (language: UiLanguageCode) => Promise<void>
}

const I18nContext = createContext<I18nContextValue>({
  language: DEFAULT_UI_LANGUAGE,
  t: (key, params) => translate(DEFAULT_UI_LANGUAGE, key, params),
  setLanguage: async () => undefined
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<UiLanguageCode>(readCachedUiLanguage)

  useEffect(() => {
    void window.electronAPI.invoke('prefs:get-ui-language').then(
      (value) => {
        const next = normalizeUiLanguage(value)
        setLanguageState(next)
        applyDocumentLanguage(next)
      },
      () => undefined
    )
    return window.electronAPI.on('prefs:ui-language-changed', (value) => {
      const next = normalizeUiLanguage(value)
      setLanguageState(next)
      applyDocumentLanguage(next)
    })
  }, [])

  const setLanguage = useCallback(async (nextLanguage: UiLanguageCode) => {
    const next = normalizeUiLanguage(nextLanguage)
    await window.electronAPI.invoke('prefs:set-ui-language', next)
    setLanguageState(next)
    applyDocumentLanguage(next)
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      t: (key, params) => translate(language, key, params),
      setLanguage
    }),
    [language, setLanguage]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// The context hooks and their provider share this module.
// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

// eslint-disable-next-line react-refresh/only-export-components
export function useT(): TranslateFn {
  return useI18n().t
}
