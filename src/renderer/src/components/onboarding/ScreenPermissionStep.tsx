import { useState, useEffect, useCallback } from 'react'

export function ScreenPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)
  const [opened, setOpened] = useState(false)

  const checkPermission = useCallback(async () => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.screen) {
      setGranted(true)
    }
  }, [])

  useEffect(() => {
    checkPermission()
    const handleFocus = () => checkPermission()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkPermission])

  const handleEnable = () => {
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
          ? 'After enabling AutoDoc in System Settings, you\'ll need to restart the app for it to take effect. You can continue for now.'
          : 'AutoDoc detects your meeting window to capture screen shares and visuals. You can always enable this later in System Settings.'}
      </p>

      {granted ? (
        <button
          onClick={onNext}
          className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
        >
          Continue →
        </button>
      ) : opened ? (
        <>
          <button
            onClick={onNext}
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
