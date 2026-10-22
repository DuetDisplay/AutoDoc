export const APPEARANCE_MODES = ['light', 'dark', 'auto'] as const
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]
export type ResolvedTheme = 'light' | 'dark'

export const DEFAULT_APPEARANCE: AppearanceMode = 'auto'
export const LIGHT_WINDOW_BACKGROUND = '#FAFAF7'
export const DARK_WINDOW_BACKGROUND = '#1C1C18'
export const APPEARANCE_STORAGE_KEY = 'autodoc-appearance'

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'auto'
}

export function normalizeAppearance(value: unknown): AppearanceMode {
  return isAppearanceMode(value) ? value : DEFAULT_APPEARANCE
}

export function resolveAppearance(mode: AppearanceMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'auto') return systemDark ? 'dark' : 'light'
  return mode
}

export function nativeThemeSourceForAppearance(
  mode: AppearanceMode
): 'system' | 'light' | 'dark' {
  return mode === 'auto' ? 'system' : mode
}

export function windowBackgroundForTheme(theme: ResolvedTheme): string {
  return theme === 'dark' ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
}
