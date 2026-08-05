import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenSupportEmailResult, SupportEmailSurface } from '../../../shared/types'
import { trackEvent } from '../services/analytics'

export type SupportEmailCopyStatus = 'idle' | 'copying' | 'copied' | 'failed'

export interface SupportEmailState {
  available: boolean | null
  result: OpenSupportEmailResult | null
  requestPending: boolean
  copyStatus: SupportEmailCopyStatus
  openSupportEmail: () => Promise<void>
  copySupportEmail: () => Promise<void>
}

export function useSupportEmail(surface: SupportEmailSurface): SupportEmailState {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [result, setResult] = useState<OpenSupportEmailResult | null>(null)
  const [requestPending, setRequestPending] = useState(false)
  const [copyStatus, setCopyStatus] = useState<SupportEmailCopyStatus>('idle')
  const availableRef = useRef<boolean | null>(null)
  const resultRef = useRef<OpenSupportEmailResult | null>(null)
  const requestPendingRef = useRef(false)
  const copyPendingRef = useRef(false)

  useEffect(() => {
    let mounted = true

    window.electronAPI
      .invoke('support:get-availability')
      .then((isAvailable) => {
        if (!mounted) return
        availableRef.current = isAvailable
        setAvailable(isAvailable)
      })
      .catch(() => {
        if (!mounted) return
        availableRef.current = false
        setAvailable(false)
      })

    return () => {
      mounted = false
    }
  }, [])

  const openSupportEmail = useCallback(async (): Promise<void> => {
    if (availableRef.current !== true || requestPendingRef.current || resultRef.current !== null) {
      return
    }

    requestPendingRef.current = true
    setRequestPending(true)
    setCopyStatus('idle')
    trackEvent('support_email_requested', { surface })

    try {
      const nextResult = await window.electronAPI.invoke('support:open-email', surface)
      resultRef.current = nextResult
      setResult(nextResult)
      trackEvent('support_email_outcome', {
        surface,
        outcome:
          nextResult.status === 'opened'
            ? 'draft_opened'
            : nextResult.status === 'copy-required'
              ? 'copy_required'
              : 'unavailable'
      })
    } catch {
      const unavailableResult = { status: 'unavailable' } as const
      resultRef.current = unavailableResult
      setResult(unavailableResult)
      trackEvent('support_email_outcome', { surface, outcome: 'unavailable' })
    } finally {
      requestPendingRef.current = false
      setRequestPending(false)
    }
  }, [surface])

  const copySupportEmail = useCallback(async (): Promise<void> => {
    if (
      resultRef.current?.status !== 'copy-required' ||
      copyPendingRef.current ||
      copyStatus === 'copied'
    ) {
      return
    }

    copyPendingRef.current = true
    setCopyStatus('copying')

    try {
      const copyResult = await window.electronAPI.invoke('support:copy-email', surface)
      if (copyResult.status === 'copied') {
        setCopyStatus('copied')
        trackEvent('support_email_outcome', { surface, outcome: 'address_copied' })
      } else if (copyResult.status === 'copy-failed') {
        setCopyStatus('failed')
        trackEvent('support_email_outcome', { surface, outcome: 'copy_failed' })
      } else {
        const unavailableResult = { status: 'unavailable' } as const
        resultRef.current = unavailableResult
        setResult(unavailableResult)
        setCopyStatus('failed')
        trackEvent('support_email_outcome', { surface, outcome: 'unavailable' })
      }
    } catch {
      setCopyStatus('failed')
      trackEvent('support_email_outcome', { surface, outcome: 'copy_failed' })
    } finally {
      copyPendingRef.current = false
    }
  }, [copyStatus, surface])

  return {
    available,
    result,
    requestPending,
    copyStatus,
    openSupportEmail,
    copySupportEmail
  }
}
