import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarAccount } from '../../../shared/types'
import { recordPersistentDiagnosticAction } from '../services/diagnostic-trail'

type CalendarProviderType = 'google' | 'microsoft'

interface UseCalendarConnectOptions {
  /** Called after a connection completes and is still the active attempt. */
  onConnected?: (account: CalendarAccount, provider: CalendarProviderType) => void | Promise<void>
  /** Called when an active attempt fails (superseded attempts are ignored). */
  onError?: (provider: CalendarProviderType, error: unknown) => void
  /** Builds the user-facing error message for a failed attempt. */
  formatError?: (provider: CalendarProviderType) => string
}

interface UseCalendarConnectResult {
  connectingProvider: CalendarProviderType | null
  isConnecting: boolean
  error: string | null
  connect: (provider: CalendarProviderType) => Promise<void>
  clearError: () => void
}

const PROVIDER_LABEL: Record<CalendarProviderType, string> = {
  google: 'Google Calendar',
  microsoft: 'Microsoft Outlook'
}

/**
 * Shared calendar-connect handling for every surface (onboarding, homepage banner,
 * settings). There are exactly three states, driven directly by the OAuth result:
 *
 *  1. Connecting — pressing connect opens the external OAuth browser and shows a
 *     disabled "Connecting" button until the attempt settles. We intentionally do
 *     NOT clear this when the browser opens (a window `blur`): doing so flips the
 *     button back the instant it was pressed, which reads as a visual hitch. While
 *     the user is off in the browser the app is backgrounded, so the disabled state
 *     isn't even visible — and the connect IPC now resolves the moment tokens
 *     arrive, so it clears on its own right as they return.
 *  2. Success — the awaited `calendar:connect` resolves with the account, which we
 *     surface through `onConnected` (e.g. onboarding shows Continue; settings adds
 *     the account to the list).
 *  3. Failure — the awaited `calendar:connect` rejects, which we surface as `error`.
 *
 * Abandoned OAuth (the user closes the tab without finishing) is the one case the
 * IPC can't settle quickly, so we clear "Connecting" when the window regains focus
 * — i.e. the user came back without completing the flow. That fires on return, not
 * on hand-off, so it never causes the click-time flash. A successful attempt has
 * already resolved by then, making this a no-op for the happy path. An `attemptId`
 * token makes a superseded attempt's late resolution/rejection a no-op so it can't
 * surface a stale success or error.
 */
export function useCalendarConnect(options: UseCalendarConnectOptions = {}): UseCalendarConnectResult {
  const [connectingProvider, setConnectingProvider] = useState<CalendarProviderType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef<symbol | null>(null)

  // Keep callbacks in a ref so the connect callback stays stable.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    // Returning to the app while still "Connecting" means the user came back without
    // finishing OAuth (a successful attempt would already have resolved). Drop the
    // disabled state so they can retry. We only clear the display, NOT the attempt
    // token: if the awaited IPC is about to resolve (they returned a beat early), the
    // success still surfaces. A re-press supersedes any genuinely abandoned flow.
    const handleFocus = (): void => setConnectingProvider(null)
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const connect = useCallback(async (provider: CalendarProviderType): Promise<void> => {
    // A new attempt supersedes any previous one (the main process cancels the
    // earlier loopback flow), so we don't block re-presses.
    const attemptId = Symbol(provider)
    attemptRef.current = attemptId
    setConnectingProvider(provider)
    setError(null)

    try {
      const account = await window.electronAPI.invoke('calendar:connect', provider)
      if (attemptRef.current !== attemptId) return
      // Definitive marker that the UI surfaced a connected calendar without a relaunch.
      recordPersistentDiagnosticAction({
        category: 'system',
        action: 'calendar_connected',
        details: { provider }
      })
      await optionsRef.current.onConnected?.(account, provider)
    } catch (err) {
      // A superseded attempt is no longer the active one — stay quiet.
      if (attemptRef.current !== attemptId) return
      console.error('Failed to connect calendar:', err)
      optionsRef.current.onError?.(provider, err)
      const message =
        optionsRef.current.formatError?.(provider) ??
        `We couldn't connect ${PROVIDER_LABEL[provider]}. Check the permission prompt and try again.`
      setError(message)
    } finally {
      if (attemptRef.current === attemptId) {
        attemptRef.current = null
        setConnectingProvider(null)
      }
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return {
    connectingProvider,
    isConnecting: connectingProvider !== null,
    error,
    connect,
    clearError
  }
}
