import { app } from 'electron'

const isE2E = process.env.AUTODOC_E2E === '1'
const allowSystemWhisperFallback = (): boolean =>
  process.env.AUTODOC_ALLOW_SYSTEM_RUNTIME_FALLBACK === '1'

export function usesManagedRuntimeOnly(): boolean {
  return app.isPackaged && !isE2E
}

export function canUseSystemRuntimeFallback(): boolean {
  return !usesManagedRuntimeOnly()
}

export function canUseSystemWhisperFallback(): boolean {
  return canUseSystemRuntimeFallback() && allowSystemWhisperFallback()
}
