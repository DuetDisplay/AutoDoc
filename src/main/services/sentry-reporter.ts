import type * as SentryType from '@sentry/electron/main'

export interface ErrorContext {
  area: string
  meetingId?: string
  tags?: Record<string, string>
  extra?: Record<string, unknown>
}

let Sentry: typeof SentryType | null = null

export function initSentryReporter(sentry: typeof SentryType): void {
  Sentry = sentry
}

export function disableSentryReporter(): void {
  Sentry = null
}

export function captureError(error: unknown, context: ErrorContext): void {
  const currentSentry = Sentry
  if (!currentSentry) return

  currentSentry.withScope((scope) => {
    scope.setTag('area', context.area)
    if (context.meetingId) scope.setTag('meetingId', context.meetingId)
    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value)
      }
    }
    if (context.extra) {
      scope.setExtras(context.extra)
    }

    currentSentry.captureException(error instanceof Error ? error : new Error(String(error)))
  })
}

export function setGlobalContext(key: string, data: Record<string, unknown>): void {
  Sentry?.setContext(key, data)
}

export function setGlobalTag(key: string, value: string): void {
  Sentry?.setTag(key, value)
}
