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

    return unsub
  }, [])

  const setAppearance = useCallback(async (nextAppearance: AppearanceMode) => {
    const next = normalizeAppearance(nextAppearance)
    applyAppearance(next)
    setAppearanceState(next)
    await window.electronAPI.invoke('prefs:set-appearance', next)
  }, [])

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// The context hook and its provider share this module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAppearance(): ThemeContextValue {
  return useContext(ThemeContext)
}
