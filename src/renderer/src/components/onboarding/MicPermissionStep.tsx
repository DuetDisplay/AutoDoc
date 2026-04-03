import { useState, useEffect, useCallback } from 'react'

export function MicPermissionStep({ onNext }: { onNext: () => void }) {
  const [granted, setGranted] = useState(false)
  const [opened, setOpened] = useState(false)

  const checkPermission = useCallback(async (autoAdvance = false) => {
    const perms = await window.electronAPI.invoke('permissions:check')
    if (perms.microphone) {
      if (autoAdvance) {
        onNext()
      } else {
        setGranted(true)
      }
    }
  }, [onNext])

  useEffect(() => {
    checkPermission(true)
    const handleFocus = () => checkPermission()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkPermission])

  const handleEnable = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      await checkPermission()
    } catch {
      window.electronAPI.invoke('permissions:open-settings', 'microphone')
      setOpened(true)
    }
  }

  const handleRelaunch = () => {
    window.electronAPI.invoke('app:relaunch')
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
        {opened
          ? 'After enabling AutoDoc in System Settings, you may need to restart the app for it to take effect.'
          : 'AutoDoc needs your microphone to capture meeting audio. This is the core of how transcription works — without it, we can\'t hear your meetings.'}
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
            onClick={handleRelaunch}
            className="px-8 py-3 bg-sage text-white rounded-[10px] text-[14px] font-semibold hover:opacity-90 transition-opacity"
          >
            Restart AutoDoc
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
