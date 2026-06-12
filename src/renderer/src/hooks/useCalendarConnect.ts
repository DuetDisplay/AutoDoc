import { useCallback, useEffect, useRef, useState } from 'react'
import type { CalendarAccount } from '../../../shared/types'

type CalendarProviderType = 'google' | 'microsoft'

interface UseCalendarConnectOptions {
  /** Called after a connection completes and is still the active attempt. */
  onConnected?: (account: CalendarAccount, provider: CalendarProviderType) => void | Promise<void>
  /** Called when an active attempt fails (cancelled/superseded attempts are ignored). */
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
 * settings).
 *
 * The OAuth flow opens an external browser and the main process waits on a loopback
 * callback. If the user closes that tab without finishing, the attempt is abandoned
 * and the main-process `CalendarManager` stays "connecting". This hook recovers from
 * that in two ways:
 *
 *  - When the app window regains focus while an attempt is in flight (i.e. the user
 *    came back from the browser without completing the flow), it cancels the pending
 *    connection via `calendar:cancel-connect`.
 *  - It tracks the active attempt so a late-arriving resolution/rejection from a
 *    cancelled or superseded attempt is ignored instead of surfacing a spurious
 *    success or error.
 *
 * The main process additionally supersedes an in-flight attempt when a new one
 * starts, so pressing the button again from any surface also recovers.
 */
export function useCalendarConnect(options: UseCalendarConnectOptions = {}): UseCalendarConnectResult {
  const [connectingProvider, setConnectingProvider] = useState<CalendarProviderType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef<symbol | null>(null)

  // Keep callbacks in a ref so the focus listener and connect callback stay stable.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const handleFocus = (): void => {
      if (!attemptRef.current) return

      // The user returned to the app without completing OAuth (e.g. closed the tab).
      // Abandon the in-flight attempt so the next press isn't blocked.
      attemptRef.current = null
      setConnectingProvider(null)
      void window.electronAPI.invoke('calendar:cancel-connect').catch((err) => {
        console.error('Failed to cancel calendar connection:', err)
      })
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const connect = useCallback(async (provider: CalendarProviderType): Promise<void> => {
    if (attemptRef.current) return

    const attemptId = Symbol(provider)
    attemptRef.current = attemptId
    setConnectingProvider(provider)
    setError(null)

    try {
      const account = await window.electronAPI.invoke('calendar:connect', provider)
      if (attemptRef.current !== attemptId) return
      await optionsRef.current.onConnected?.(account, provider)
    } catch (err) {
      // A cancelled or superseded attempt is no longer the active one — stay quiet.
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
