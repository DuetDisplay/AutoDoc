let lastResumeAtMs: number | null = null

export function markOllamaResumed(atMs: number = Date.now()): void {
  lastResumeAtMs = atMs
}

export function getMsSinceLastResume(nowMs: number = Date.now()): number | null {
  if (lastResumeAtMs == null) return null
  return Math.max(0, nowMs - lastResumeAtMs)
}

export function resetOllamaResumeClock(): void {
  lastResumeAtMs = null
}
