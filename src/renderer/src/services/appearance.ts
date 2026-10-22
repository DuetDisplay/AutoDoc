import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolveAppearance,
  type AppearanceMode
} from '../../../shared/appearance'

export function readCachedAppearance(): AppearanceMode {
  try {
    return normalizeAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function applyAppearance(mode: AppearanceMode): void {
  const next = normalizeAppearance(mode)
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next)
  } catch {
    // Private mode or blocked storage should not prevent the theme from applying.
  }
  const dark =
    resolveAppearance(next, window.matchMedia('(prefers-color-scheme: dark)').matches) === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

applyAppearance(readCachedAppearance())

