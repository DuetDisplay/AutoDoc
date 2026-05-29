import { useCallback, useEffect, useState, type ReactElement } from 'react'

export function LowSpecMacProcessingBanner(): ReactElement | null {
  const [visible, setVisible] = useState(false)

  const refreshVisibility = useCallback(async () => {
    try {
      const [setupStatus, dismissed, recordings] = await Promise.all([
        window.electronAPI.invoke('whisper:get-setup-status'),
        window.electronAPI.invoke('prefs:get-low-spec-mac-processing-banner-dismissed'),
        window.electronAPI.invoke('recording:list')
      ])

      const hasRecordings = Array.isArray(recordings) && recordings.length > 0
      setVisible(
        setupStatus?.macProcessingProfileId === 'mac-low-spec' &&
          dismissed !== true &&
          hasRecordings
      )
    } catch {
      setVisible(false)
    }
  }, [])

  useEffect(() => {
    void refreshVisibility()

    const unsubSetup = window.electronAPI.on('whisper:setup-progress', () => {
      void refreshVisibility()
    })
    const unsubRecording = window.electronAPI.on('recording:status-changed', () => {
      void refreshVisibility()
    })
    const unsubEntry = window.electronAPI.on('recording:entry-updated', () => {
      void refreshVisibility()
    })

    return () => {
      unsubSetup()
      unsubRecording()
      unsubEntry()
    }
  }, [refreshVisibility])

  const dismiss = async (): Promise<void> => {
    setVisible(false)
    try {
      await window.electronAPI.invoke('prefs:set-low-spec-mac-processing-banner-dismissed', true)
    } catch (err) {
      console.warn('Failed to dismiss low-spec Mac processing banner:', err)
      setVisible(true)
    }
  }

  if (!visible) return null

  return (
    <div
      className="mx-6 mt-2 mb-0 rounded-xl border border-sage/20 bg-bg-card px-4 py-3 shadow-sm animate-[slideDown_300ms_ease]"
      role="status"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sage/20 bg-sage-light">
          <div className="flex h-4 items-end gap-0.5">
            <span className="h-2 w-1 rounded-full bg-sage" />
            <span className="h-4 w-1 rounded-full bg-sage" />
            <span className="h-3 w-1 rounded-full bg-sage" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12.5px] font-semibold text-ink">Optimized local processing is on</h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            This Mac has limited memory, so AutoDoc is processing recordings more carefully. Notes
            may take a little longer, but this helps avoid slowdowns or failed processing.
          </p>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-[12px] font-semibold text-sage transition-colors hover:text-sage-dark"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
