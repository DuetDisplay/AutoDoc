import { useState, useEffect, useCallback } from 'react'

export function MicPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)
  const [openedSettings, setOpenedSettings] = useState(false)

  const clearOpenedState = useCallback(async () => {
    await window.electronAPI.invoke('prefs:set-onboarding-permission-settings-opened', 'microphone', false)
    setOpenedSettings(false)
  }, [])

  const handleContinue = useCallback(async () => {
    await clearOpenedState()
    onNext()
  }, [clearOpenedState, onNext])

  const checkPermission = useCallback(async (autoAdvance = false) => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.microphone) {
      if (autoAdvance) {
        await clearOpenedState()
        onNext()
      } else {
        setGranted(true)
      }
      return
    }
    setGranted(false)
  }, [clearOpenedState, onNext])

  useEffect(() => {
    let cancelled = false

    const restoreStepState = async () => {
      const wasOpened = await window.electronAPI.invoke(
        'prefs:get-onboarding-permission-settings-opened',
        'microphone',
      )
      if (!cancelled) {
        setOpenedSettings(wasOpened)
      }
      await checkPermission(true)
    }

    void restoreStepState()
    const handleFocus = () => checkPermission()
    window.addEventListener('focus', handleFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', handleFocus)
    }
  }, [checkPermission])

  const handleEnable = async () => {
    try {
      const permissionGranted = await window.electronAPI.invoke('permissions:request-microphone')
      if (permissionGranted) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((t) => t.stop())
        } catch {
          // Recording capture performs its own getUserMedia validation later.
        }
        setGranted(true)
        await clearOpenedState()
        return
      }
    } catch {
      // Fall through to System Settings recovery on prompt failures.
    }

    await window.electronAPI.invoke('prefs:set-onboarding-permission-settings-opened', 'microphone', true)
    window.electronAPI.invoke('permissions:open-settings', 'microphone')
    setOpenedSettings(true)
  }

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-clay-light text-clay-dark rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        REQUIRED
      </span>
      <div className="w-16 h-16 rounded-2xl bg-clay-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🎤
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Microphone Access</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        {openedSettings && !granted
          ? 'macOS may require a restart for the permission to take effect. If you chose "Restart Later", you can continue setup and grant access from Settings later.'
          : 'AutoDoc needs your microphone to capture meeting audio. This is the core of how transcription works — without it, we can\'t hear your meetings.'}
      </p>

      {granted ? (
        <button
          onClick={() => void handleContinue()}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : openedSettings ? (
        <>
          <button
            onClick={() => void handleContinue()}
            className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            Continue →
          </button>
          <button
            onClick={handleEnable}
            className="block mx-auto mt-3 text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
          >
            Open Settings again
          </button>
        </>
      ) : (
        <button
          onClick={handleEnable}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Enable Microphone
        </button>
      )}
    </div>
  )
}
