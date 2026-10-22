import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { normalizeAppearance, type AppearanceMode } from '../../../shared/appearance'
import { applyAppearance, readCachedAppearance } from './appearance'

interface ThemeContextValue {
  appearance: AppearanceMode
  setAppearance: (appearance: AppearanceMode) => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue>({
  appearance: readCachedAppearance(),
  setAppearance: async () => undefined
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<AppearanceMode>(readCachedAppearance)

  useEffect(() => {
    void window.electronAPI.invoke('prefs:get-appearance').then(
      (value) => {
        const next = normalizeAppearance(value)
        setAppearanceState(next)
        applyAppearance(next)
      },
      () => undefined
    )

    const unsub = window.electronAPI.on('prefs:appearance-changed', (value) => {
      const next = normalizeAppearance(value)
      setAppearanceState(next)
      applyAppearance(next)
    })

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = (): void => {
      const current = readCachedAppearance()
      if (current === 'auto') applyAppearance('auto')
    }
    media.addEventListener('change', onSystemChange)
    return () => {
      unsub()
      media.removeEventListener('change', onSystemChange)
    }
  }, [])

  const setAppearance = useCallback(async (nextAppearance: AppearanceMode) => {
    const next = normalizeAppearance(nextAppearance)
    applyAppearance(next)
    setAppearanceState(next)
    await window.electronAPI.invoke('prefs:set-appearance', next)
  }, [])

  const value = useMemo(
    () => ({ appearance, setAppearance }),
    [appearance, setAppearance]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useAppearance(): ThemeContextValue {
  return useContext(ThemeContext)
}
