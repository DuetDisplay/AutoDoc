import { useState, useEffect, useCallback } from 'react'

interface Permissions {
  screen: boolean
  microphone: boolean
}

export function SetupGuide({ onComplete }: { onComplete: () => void }) {
  const [permissions, setPermissions] = useState<Permissions | null>(null)
  const [checking, setChecking] = useState(true)

  const checkPermissions = useCallback(async () => {
    setChecking(true)
    const result = await window.electronAPI.invoke('permissions:check')
    setPermissions(result)
    setChecking(false)
    if (result.microphone) {
      onComplete()
    }
  }, [onComplete])

  useEffect(() => {
    checkPermissions()
  }, [checkPermissions])

  // Re-check when window regains focus (user may have toggled permissions)
  useEffect(() => {
    const handleFocus = () => checkPermissions()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [checkPermissions])

  if (checking || !permissions) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <p className="text-ink-muted text-[13px]">Checking permissions...</p>
      </div>
    )
  }

  if (permissions.microphone) return null

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full">
        <h2 className="text-[18px] font-bold text-ink tracking-[-0.03em]">
          Welcome to AutoDoc
        </h2>
        <p className="text-[13px] text-ink-muted mt-2 leading-relaxed">
          AutoDoc records your meetings and turns them into structured notes. Everything stays on your device.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <PermissionCard
            title="Microphone"
            description="Required to capture meeting audio"
            granted={permissions.microphone}
            required
            onGrant={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                stream.getTracks().forEach((t) => t.stop())
                checkPermissions()
              } catch {
                window.electronAPI.invoke('permissions:open-settings', 'microphone')
              }
            }}
          />
          <PermissionCard
            title="Screen Recording"
            description="Optional — enables recording the meeting window"
            granted={permissions.screen}
            required={false}
            onGrant={() => window.electronAPI.invoke('permissions:open-settings', 'screen')}
          />
        </div>

        <button
          onClick={checkPermissions}
          className="mt-5 text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
        >
          Re-check permissions
        </button>
      </div>
    </div>
  )
}

function PermissionCard({
  title,
  description,
  granted,
  required,
  onGrant,
}: {
  title: string
  description: string
  granted: boolean
  required: boolean
  onGrant: () => void
}) {
  return (
    <div className="px-4 py-3.5 bg-bg-card border border-border rounded-xl flex justify-between items-center">
      <div className="flex items-center gap-3">
        <div
          className={`w-2.5 h-2.5 rounded-full ${
            granted ? 'bg-status-connected' : required ? 'bg-status-recording' : 'bg-border'
          }`}
        />
        <div>
          <div className="text-[13px] font-semibold text-ink">
            {title}
            {!required && (
              <span className="text-[10px] font-normal text-ink-faint ml-1.5">optional</span>
            )}
          </div>
          <div className="text-[11px] text-ink-faint mt-0.5">{description}</div>
        </div>
      </div>
      {granted ? (
        <span className="text-[11px] font-medium text-status-connected">Granted</span>
      ) : (
        <button
          onClick={onGrant}
          className={`text-[11px] font-medium px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity ${
            required
              ? 'text-white bg-ink'
              : 'text-ink-muted bg-bg-accent border border-border-subtle'
          }`}
        >
          Grant
        </button>
      )}
    </div>
  )
}
