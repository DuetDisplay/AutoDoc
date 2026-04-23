import type * as SentryType from '@sentry/electron/main'
import { getDiagnosticTrail } from './diagnostic-trail'

export interface ErrorContext {
  area: string
  meetingId?: string
  tags?: Record<string, string>
  extra?: Record<string, unknown>
}

export interface MessageContext extends ErrorContext {
  level?: 'info' | 'warning' | 'error'
}

let Sentry: typeof SentryType | null = null

export function initSentryReporter(sentry: typeof SentryType): void {
  Sentry = sentry
}

export function disableSentryReporter(): void {
  Sentry = null
}

export function resetSentryScopes(): void {
  const currentSentry = Sentry
  if (!currentSentry) return

  const scopeAwareSentry = currentSentry as typeof SentryType & {
    getIsolationScope(): { clear(): void }
    getCurrentScope(): { clear(): void }
  }

  const isolationScope = scopeAwareSentry.getIsolationScope()
  const currentScope = scopeAwareSentry.getCurrentScope()

  isolationScope.clear()
  if (currentScope !== isolationScope) {
    currentScope.clear()
  }
}

export function captureError(error: unknown, context: ErrorContext): void {
  const currentSentry = Sentry
  if (!currentSentry) return
  const diagnosticTrail = getDiagnosticTrail()

  currentSentry.withScope((scope) => {
    scope.setTag('area', context.area)
    if (context.meetingId) scope.setTag('meetingId', context.meetingId)
    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value)
      }
    }
    if (context.extra) {
      scope.setExtras({
        ...context.extra,
        diagnosticTrail,
      })
    } else {
      scope.setExtras({ diagnosticTrail })
    }

    currentSentry.captureException(error instanceof Error ? error : new Error(String(error)))
  })
}

export function captureMessage(message: string, context: MessageContext): void {
  const currentSentry = Sentry
  if (!currentSentry) return
  const diagnosticTrail = getDiagnosticTrail()
  const messageAwareSentry = currentSentry as typeof SentryType & {
    captureMessage?: (message: string, level?: MessageContext['level']) => void
  }

  currentSentry.withScope((scope) => {
    scope.setTag('area', context.area)
    if (context.meetingId) scope.setTag('meetingId', context.meetingId)
    if (context.tags) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value)
      }
    }
    if (context.extra) {
      scope.setExtras({
        ...context.extra,
        diagnosticTrail,
      })
    } else {
      scope.setExtras({ diagnosticTrail })
    }

    messageAwareSentry.captureMessage?.(message, context.level ?? 'info')
  })
}

export function setGlobalContext(key: string, data: Record<string, unknown>): void {
  Sentry?.setContext(key, data)
}

export function setGlobalTag(key: string, value: string): void {
  Sentry?.setTag(key, value)
}
