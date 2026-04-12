import { useState, useEffect, useCallback } from 'react'

export function ScreenPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)
  const [opened, setOpened] = useState(false)

  const clearOpenedState = useCallback(async () => {
    await window.electronAPI.invoke('prefs:set-onboarding-permission-settings-opened', 'screen', false)
    setOpened(false)
  }, [])

  const handleContinue = useCallback(async () => {
    await clearOpenedState()
    onNext()
  }, [clearOpenedState, onNext])

  const checkPermission = useCallback(async (autoAdvance = false) => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.screen) {
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
        'screen',
      )
      if (!cancelled) {
        setOpened(wasOpened)
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
    await window.electronAPI.invoke('prefs:set-onboarding-permission-settings-opened', 'screen', true)
    window.electronAPI.invoke('permissions:open-settings', 'screen')
    setOpened(true)
  }

  return (
    <div className="text-center">
      <span className="inline-block px-2.5 py-1 bg-mist-light text-ink-muted rounded-md text-[11px] font-semibold uppercase tracking-wider mb-4">
        OPTIONAL
      </span>
      <div className="w-16 h-16 rounded-2xl bg-mist-light flex items-center justify-center text-[28px] mx-auto mb-5">
        🖥️
      </div>
      <h2 className="text-[20px] font-bold text-ink tracking-[-0.02em] mb-2">Screen Recording</h2>
      <p className="text-[14px] text-ink-muted leading-relaxed mb-7">
        {opened
          ? 'After enabling AutoDoc in System Settings, you\'ll need to restart the app for it to take effect. Screen visuals and system audio are verified separately when recording starts.'
          : 'AutoDoc uses screen recording permission to capture meeting visuals. macOS verifies system audio separately when a recording starts, so you can continue even if you skip this for now.'}
      </p>

      {granted ? (
        <button
          onClick={() => void handleContinue()}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : opened ? (
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
        <>
          <button
            onClick={handleEnable}
            className="px-8 py-3 bg-ink text-white rounded-[10px] text-[14px] font-semibold hover:bg-ink-secondary transition-colors"
          >
            Enable Screen Recording
          </button>
          <button
            onClick={onNext}
            className="block mx-auto mt-3 text-[13px] text-ink-faint hover:text-ink-muted transition-colors"
          >
            Skip for now
          </button>
        </>
      )}
    </div>
  )
}
