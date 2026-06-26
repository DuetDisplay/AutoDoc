import { useState, useEffect, useCallback } from 'react'
import { recordPersistentDiagnosticAction } from '../../services/diagnostic-trail'
import { trackEvent } from '../../services/analytics'

export function MicPermissionStep({
  onNext,
  allowAutoAdvance = true
}: {
  onNext: () => void
  allowAutoAdvance?: boolean
}) {
  const [granted, setGranted] = useState(false)
  const [openedSettings, setOpenedSettings] = useState(false)

  const recordPermissionTrace = useCallback((action: string, details?: Record<string, unknown>) => {
    recordPersistentDiagnosticAction({
      category: 'system',
      action,
      details: {
        panel: 'microphone',
        ...details
      }
    })
  }, [])

  const clearOpenedState = useCallback(async () => {
    await window.electronAPI.invoke(
      'prefs:set-onboarding-permission-settings-opened',
      'microphone',
      false
    )
    setOpenedSettings(false)
    recordPermissionTrace('microphone_permission_opened_state_cleared')
  }, [recordPermissionTrace])

  const handleContinue = useCallback(async () => {
    recordPermissionTrace('microphone_permission_continue_clicked', {
      granted,
      openedSettings
    })
    await clearOpenedState()
    onNext()
  }, [clearOpenedState, granted, onNext, openedSettings, recordPermissionTrace])

  const checkPermission = useCallback(
    async (autoAdvance = false, reason = 'unspecified') => {
      const perms = await window.electronAPI.invoke('permissions:check')
      recordPermissionTrace('microphone_permission_check_completed', {
        autoAdvance,
        reason,
        microphoneGranted: perms.microphone,
        screenGranted: perms.screen
      })
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
    },
    [clearOpenedState, onNext, recordPermissionTrace]
  )

  useEffect(() => {
    let cancelled = false

    const restoreStepState = async () => {
      const wasOpened = await window.electronAPI.invoke(
        'prefs:get-onboarding-permission-settings-opened',
        'microphone'
      )
      if (!cancelled) {
        setOpenedSettings(wasOpened)
      }
      recordPermissionTrace('microphone_permission_step_restored', {
        allowAutoAdvance,
        openedSettings: wasOpened
      })
      await checkPermission(allowAutoAdvance, 'restore')
    }

    void restoreStepState()
    const handleFocus = () => {
      recordPermissionTrace('microphone_permission_window_focused')
      void checkPermission(false, 'focus')
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', handleFocus)
    }
  }, [allowAutoAdvance, checkPermission, recordPermissionTrace])

  const handleEnable = async () => {
    trackEvent('permission_requested', { permission_type: 'microphone' })
    recordPermissionTrace('microphone_permission_enable_clicked', {
      openedSettings,
      granted
    })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      recordPermissionTrace('microphone_permission_get_user_media_succeeded')
    } catch (error) {
      recordPermissionTrace('microphone_permission_get_user_media_failed', {
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      })
      // We'll fall through to the OS-level permission check below.
    }

    const perms = await window.electronAPI.invoke('permissions:check')
    recordPermissionTrace('microphone_permission_post_get_user_media_check', {
      microphoneGranted: perms.microphone,
      screenGranted: perms.screen
    })
    if (perms.microphone) {
      trackEvent('permission_granted', { permission_type: 'microphone' })
      setGranted(true)
      await clearOpenedState()
      return
    }

    recordPermissionTrace('microphone_permission_app_request_started')
    await window.electronAPI.invoke('permissions:request-microphone-access')

    const requestedPerms = await window.electronAPI.invoke('permissions:check')
    recordPermissionTrace('microphone_permission_post_app_request_check', {
      microphoneGranted: requestedPerms.microphone,
      screenGranted: requestedPerms.screen
    })
    if (requestedPerms.microphone) {
      trackEvent('permission_granted', { permission_type: 'microphone' })
      setGranted(true)
      await clearOpenedState()
      return
    }

    trackEvent('permission_denied', { permission_type: 'microphone' })
    await window.electronAPI.invoke(
      'prefs:set-onboarding-permission-settings-opened',
      'microphone',
      true
    )
    recordPermissionTrace('microphone_permission_settings_fallback_opened')
    await window.electronAPI.invoke('permissions:open-settings', 'microphone')
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
          : "AutoDoc needs your microphone to capture meeting audio. This is the core of how transcription works — without it, we can't hear your meetings."}
      </p>

      <div className="flex items-start gap-3 px-4 py-3 bg-bg-card border border-border rounded-xl text-left mb-7">
        <div className="w-9 h-9 rounded-lg bg-[#FEF3C7] flex items-center justify-center text-[16px] shrink-0">
          🎧
        </div>
        <div>
          <div className="text-[13px] font-semibold text-ink">
            Use headphones for the clearest notes
          </div>
          <div className="text-[12px] text-ink-muted leading-snug mt-0.5">
            Wear headphones while recording. They help AutoDoc tell your voice apart from everyone
            else&apos;s and make playback cleaner.
          </div>
        </div>
      </div>

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
