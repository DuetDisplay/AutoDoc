import { BrowserWindow, nativeTheme } from 'electron'
import {
  nativeThemeSourceForAppearance,
  resolveAppearance,
  windowBackgroundForTheme,
  type AppearanceMode,
  type ResolvedTheme
} from '../../shared/appearance'

export function applyNativeAppearance(mode: AppearanceMode): void {
  nativeTheme.themeSource = nativeThemeSourceForAppearance(mode)
  const background = windowBackgroundForTheme(resolveNativeTheme(mode))
  for (const win of BrowserWindow.getAllWindows()) {
    // Floating notification windows draw their own translucent surface.
    if (win.isFocusable?.() !== false) win.setBackgroundColor?.(background)
    else win.webContents.send?.('notification:appearance', nativeTheme.shouldUseDarkColors)
  }
}

export function resolveNativeTheme(mode: AppearanceMode): ResolvedTheme {
  nativeTheme.themeSource = nativeThemeSourceForAppearance(mode)
  return resolveAppearance(mode, nativeTheme.shouldUseDarkColors)
}

export function windowBackgroundForAppearance(mode: AppearanceMode): string {
  return windowBackgroundForTheme(resolveNativeTheme(mode))
}
