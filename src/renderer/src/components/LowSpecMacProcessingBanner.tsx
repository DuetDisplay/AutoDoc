import { useT } from '../services/i18n'
import { useEffect, useState, type ReactElement } from 'react'
import type { WhisperSetupStatus } from '../../../shared/types'

export function LowSpecMacProcessingBanner({
  onVisibilityChange
}: {
  onVisibilityChange?: (visible: boolean) => void
}): ReactElement | null {
  const t = useT()

  const [hasRecordings, setHasRecordings] = useState(false)
  const [isLowSpecHost, setIsLowSpecHost] = useState(false)
  const [dismissed, setDismissed] = useState(true)
  const visible = isLowSpecHost && hasRecordings && !dismissed

  useEffect(() => {
    let disposed = false
    let receivedSetupEvent = false
    let refreshing = false
    let refreshRequested = false
    const applyStatus = (status: WhisperSetupStatus): void => {
      if (!disposed)
        setIsLowSpecHost(
          status?.macProcessingProfileId === 'mac-low-spec' ||
            status?.windowsProcessingProfileId === 'win-low-spec'
        )
    }
    // Coalesce bursts and discard responses invalidated by an event while reading.
    const refreshRecordings = async (): Promise<void> => {
      refreshRequested = true
      if (refreshing) return
      refreshing = true
      try {
        while (refreshRequested && !disposed) {
          refreshRequested = false
          const recordings = await window.electronAPI.invoke('recording:list').catch(() => [])
          if (!disposed && !refreshRequested)
            setHasRecordings(Array.isArray(recordings) && recordings.length > 0)
        }
      } finally {
        refreshing = false
      }
    }

    const unsubSetup = window.electronAPI.on('whisper:setup-progress', (status) => {
      receivedSetupEvent = true
      applyStatus(status)
    })
    const unsubRecording = window.electronAPI.on('recording:status-changed', () => {
      void refreshRecordings()
    })
    const unsubEntry = window.electronAPI.on('recording:entry-updated', () => {
      void refreshRecordings()
    })
    void refreshRecordings()
    void window.electronAPI
      .invoke('whisper:get-setup-status')
      .then((status) => {
        if (!receivedSetupEvent) applyStatus(status)
      })
      .catch(() => {})
    void window.electronAPI
      .invoke('prefs:get-low-spec-mac-processing-banner-dismissed')
      .then((value) => {
        if (!disposed) setDismissed(value === true)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubSetup()
      unsubRecording()
      unsubEntry()
    }
  }, [])

  useEffect(() => {
    onVisibilityChange?.(visible)
  }, [onVisibilityChange, visible])

  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange])

  const dismiss = async (): Promise<void> => {
    setDismissed(true)
    try {
      await window.electronAPI.invoke('prefs:set-low-spec-mac-processing-banner-dismissed', true)
    } catch (err) {
      console.warn('Failed to dismiss low-spec Mac processing banner:', err)
      setDismissed(false)
    }
  }

  if (!visible) return null

  return (
    <div
      className="app-banner mx-6 mt-2 mb-0 rounded-xl border border-sage/20 bg-bg-card px-4 py-3 shadow-sm animate-[slideDown_300ms_ease]"
      role="status"
    >
      <div className="app-banner-row">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sage/20 bg-sage-light">
          <div className="flex h-4 items-end gap-0.5">
            <span className="h-2 w-1 rounded-full bg-sage" />
            <span className="h-4 w-1 rounded-full bg-sage" />
            <span className="h-3 w-1 rounded-full bg-sage" />
          </div>
        </div>
        <div className="app-banner-copy">
          <h2 className="text-[12.5px] font-semibold text-ink">
            {t('ui.optimizedLocalProcessingIsOn')}
          </h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t('ui.thisComputerHasLimitedMemorySoAutoDocIsProcessingRecordingsMoreCarefullyNot')}
          </p>
        </div>
        <div className="app-banner-actions">
          <button
            onClick={dismiss}
            className="i18n-btn text-[12px] font-semibold text-sage transition-colors hover:text-sage-dark"
          >
            {t('ui.gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}
