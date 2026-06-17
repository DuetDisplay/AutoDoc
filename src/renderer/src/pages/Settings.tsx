import { useState, useEffect, useCallback, useRef } from 'react'
import { PageHeader } from '../components/PageHeader'
import { useCalendarStore } from '../stores/calendar'
import { useCalendarConnect } from '../hooks/useCalendarConnect'
import type { UpdateStatus } from '../../../preload/ipc.d'
import type { AppRuntimeInfo, AppStorageInfo, CalendarAccount } from '../../../shared/types'
import {
  identifyConsentedInstall,
  setAnalyticsConsent,
  startAnalyticsSession,
  toDurationBucket,
  trackConsentSnapshot,
  trackDailyActiveIfNeeded,
  trackEvent
} from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'

function getCalendarAccountLabel(account: CalendarAccount): string {
  const email = account.email.trim()
  if (email) {
    return email
  }

  return account.provider === 'google' ? 'Google account' : 'Microsoft account'
}

function getCalendarSyncIssueMessage(account: CalendarAccount): string | null {
  if (account.syncIssue === 'unsupported-mailbox') {
    return 'Calendar sync is unavailable for this Microsoft mailbox type.'
  }
  if (account.syncIssue === 'reconnect-required') {
    return 'Microsoft Outlook needs to be reconnected to resume calendar sync.'
  }

  return null
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'Loading...'
  if (bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export function Settings() {
  const { accounts, setAccounts, addAccount, removeAccount, setConnecting, setEvents } =
    useCalendarStore()
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [runtimeInfo, setRuntimeInfo] = useState<AppRuntimeInfo | null>(null)
  const [storageInfo, setStorageInfo] = useState<AppStorageInfo | null>(null)
  const [analyticsConsent, setAnalyticsConsentState] = useState<boolean | null>(null)
  const [diagnosticLogUploadConsent, setDiagnosticLogUploadConsentState] = useState(false)
  const [storageNotice, setStorageNotice] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [isRemovingDownloads, setIsRemovingDownloads] = useState(false)
  const [isResettingLocalData, setIsResettingLocalData] = useState(false)
  const previousUpdateState = useRef<UpdateStatus['state']>('idle')
  const downloadStartedAt = useRef<number | null>(null)

  const refreshStorageInfo = useCallback(() => {
    return window.electronAPI.invoke('app:get-storage-info').then(setStorageInfo)
  }, [])

  useEffect(() => {
    window.electronAPI.invoke('app:get-version').then(setAppVersion)
    window.electronAPI.invoke('updater:get-status').then(setUpdateStatus)
    window.electronAPI.invoke('app:get-runtime-info').then(setRuntimeInfo)
    void refreshStorageInfo()
    window.electronAPI.invoke('prefs:get-analytics-consent').then(setAnalyticsConsentState)
    window.electronAPI
      .invoke('prefs:get-diagnostic-log-upload-consent')
      .then(setDiagnosticLogUploadConsentState)
    const unsub = window.electronAPI.on('updater:status', setUpdateStatus)
    const unsubConsent = window.electronAPI.on(
      'prefs:analytics-consent-changed',
      setAnalyticsConsentState
    )
    const unsubDiagnosticLogConsent = window.electronAPI.on(
      'prefs:diagnostic-log-upload-consent-changed',
      setDiagnosticLogUploadConsentState
    )
    return () => {
      unsub()
      unsubConsent()
      unsubDiagnosticLogConsent()
    }
  }, [refreshStorageInfo])

  useEffect(() => {
    const previousState = previousUpdateState.current
    previousUpdateState.current = updateStatus.state

    if (updateStatus.state === 'checking' && previousState !== 'checking') {
      trackEvent('update_check_started')
      return
    }

    if (updateStatus.state === 'idle' && previousState === 'checking') {
      trackEvent('update_not_available', { current_version: appVersion })
      return
    }

    if (updateStatus.state === 'available' && updateStatus.version) {
      trackEvent('update_available', {
        current_version: appVersion,
        available_version: updateStatus.version
      })
      return
    }

    if (updateStatus.state === 'downloading' && previousState !== 'downloading') {
      downloadStartedAt.current = performance.now()
      trackEvent('update_download_started', {
        available_version: updateStatus.version ?? 'unknown'
      })
      return
    }

    if (updateStatus.state === 'downloaded' && updateStatus.version) {
      const startedAt = downloadStartedAt.current
      downloadStartedAt.current = null
      trackEvent('update_download_completed', {
        available_version: updateStatus.version,
        duration_bucket:
          startedAt === null ? undefined : toDurationBucket((performance.now() - startedAt) / 1000)
      })
      return
    }

    if (updateStatus.state === 'error') {
      trackEvent('update_download_failed', {
        available_version: updateStatus.version ?? 'unknown',
        failure_code: 'update_error'
      })
    }
  }, [appVersion, updateStatus])

  useEffect(() => {
    window.electronAPI.invoke('calendar:get-accounts').then(setAccounts)
  }, [setAccounts])

  const { connectingProvider, connect } = useCalendarConnect({
    onConnected: async (account) => {
      addAccount(account)
      trackEvent('calendar_connected', { provider: account.provider })
      const events = await window.electronAPI.invoke('calendar:get-events')
      setEvents(events)
    }
  })

  useEffect(() => {
    setConnecting(connectingProvider !== null)
  }, [connectingProvider, setConnecting])

  const handleConnect = (provider: 'google' | 'microsoft') => {
    recordDiagnosticAction({
      category: 'settings',
      action: 'calendar_connect_requested',
      details: { provider }
    })
    void connect(provider)
  }

  const handleDisconnect = async (accountId: string) => {
    recordDiagnosticAction({
      category: 'settings',
      action: 'calendar_disconnect_requested'
    })
    await window.electronAPI.invoke('calendar:disconnect', accountId)
    removeAccount(accountId)
    const events = await window.electronAPI.invoke('calendar:get-events')
    setEvents(events)
  }

  const handleToggleAnalytics = async () => {
    const nextValue = !(analyticsConsent === true)
    recordDiagnosticAction({
      category: 'settings',
      action: 'analytics_consent_toggled',
      details: { enabled: nextValue }
    })
    if (!nextValue) {
      trackEvent('analytics_disabled')
    } else {
      await identifyConsentedInstall()
    }
    await window.electronAPI.invoke('prefs:set-analytics-consent', nextValue)
    setAnalyticsConsent(nextValue)
    if (nextValue) {
      await trackConsentSnapshot()
      await startAnalyticsSession()
      await trackDailyActiveIfNeeded()
    }
    setAnalyticsConsentState(nextValue)
  }

  const handleToggleDiagnosticLogUpload = async () => {
    const nextValue = !diagnosticLogUploadConsent
    recordDiagnosticAction({
      category: 'settings',
      action: 'diagnostic_log_upload_consent_toggled',
      details: { enabled: nextValue }
    })
    await window.electronAPI.invoke('prefs:set-diagnostic-log-upload-consent', nextValue)
    setDiagnosticLogUploadConsentState(nextValue)
  }

  const handleRemoveDownloadedComponents = async () => {
    const confirmed = window.confirm(
      'Remove the downloaded AI components from this machine? AutoDoc will download them again the next time they are needed.'
    )
    if (!confirmed) return

    setStorageNotice(null)
    setStorageError(null)
    setIsRemovingDownloads(true)
    try {
      const nextStorageInfo = await window.electronAPI.invoke('app:clear-downloaded-components')
      setStorageInfo(nextStorageInfo)
      setStorageNotice(
        'Downloaded AI components removed. AutoDoc will re-download them when needed.'
      )
    } catch (err) {
      setStorageError(
        err instanceof Error ? err.message : 'Failed to remove downloaded AI components.'
      )
    } finally {
      setIsRemovingDownloads(false)
    }
  }

  const handleResetLocalData = async () => {
    const confirmed = window.confirm(
      'Delete all local AutoDoc data and restart? This removes recordings, transcripts, settings, and downloaded AI components from this machine.'
    )
    if (!confirmed) return

    setStorageNotice(null)
    setStorageError(null)
    setIsResettingLocalData(true)
    try {
      await window.electronAPI.invoke('app:reset-local-data')
      setStorageNotice('Restarting AutoDoc and clearing local data...')
    } catch (err) {
      setIsResettingLocalData(false)
      setStorageError(err instanceof Error ? err.message : 'Failed to delete local AutoDoc data.')
    }
  }

  const uninstallGuidance =
    runtimeInfo?.platform === 'win32'
      ? 'Windows uninstall can optionally remove AutoDoc local data. Use the controls here any time you want to reclaim space without uninstalling.'
      : 'Deleting AutoDoc from Applications does not remove local data on macOS. Use the controls here to reclaim space or reset the app.'

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Settings" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6 min-h-full">
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Calendars</h3>

            {accounts.length > 0 && (
              <div className="flex flex-col gap-2 mb-3">
                {accounts.map((account) => (
                  <div key={account.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-3">
                      {account.provider === 'google' ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                            fill="#4285F4"
                          />
                          <path
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            fill="#34A853"
                          />
                          <path
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"
                            fill="#FBBC05"
                          />
                          <path
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            fill="#EA4335"
                          />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
                          <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                          <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
                          <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
                          <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
                        </svg>
                      )}
                      <span className="text-[12px] text-ink-muted">
                        {getCalendarAccountLabel(account)}
                      </span>
                      <button
                        onClick={() => handleDisconnect(account.id)}
                        className="text-[12px] font-medium text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                    {getCalendarSyncIssueMessage(account) && (
                      <p className="text-[11px] text-amber-700 ml-[26px]">
                        {getCalendarSyncIssueMessage(account)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => handleConnect('google')}
                disabled={connectingProvider !== null}
                className="flex items-center gap-2 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                {connectingProvider === 'google' ? 'Connecting...' : 'Add Google Calendar'}
              </button>
              <button
                onClick={() => handleConnect('microsoft')}
                disabled={connectingProvider !== null}
                className="flex items-center gap-2 text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
              >
                <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
                  <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                  <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
                  <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
                  <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
                </svg>
                {connectingProvider === 'microsoft' ? 'Connecting...' : 'Add Microsoft Outlook'}
              </button>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Analytics & Crash Reports</h3>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <div>
                <p className="text-[12px] text-ink-muted">
                  Share anonymous usage data and crash reports to help improve AutoDoc. Meeting
                  content stays local, and technical logs are optional.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleToggleAnalytics()}
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors ${analyticsConsent ? 'bg-sage' : 'bg-ink-faint/30'}`}
                aria-pressed={analyticsConsent === true}
                aria-label="Toggle analytics and crash reports"
              >
                <span
                  className={`block h-5 w-5 rounded-full bg-white transition-transform ${analyticsConsent ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
            <div className="mt-3 rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={diagnosticLogUploadConsent}
                  onChange={() => void handleToggleDiagnosticLogUpload()}
                  disabled={analyticsConsent !== true}
                  className="mt-0.5 h-4 w-4 rounded border-border-subtle text-sage focus:ring-sage disabled:opacity-50"
                  aria-label="Attach technical app logs to error reports"
                />
                <span className="text-[12px] text-ink-muted leading-relaxed">
                  <strong className="text-ink font-semibold">
                    Attach technical app logs to error reports
                  </strong>{' '}
                  when diagnostics are enabled. This can be off while analytics and crash reports
                  stay on.
                </span>
              </label>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Auto-record</h3>
            <p className="text-[12px] text-ink-muted">Default: off</p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Whisper Model</h3>
            <p className="text-[12px] text-ink-muted">
              {runtimeInfo?.whisperModel ?? 'Loading...'}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Ollama Model</h3>
            <p className="text-[12px] text-ink-muted">{runtimeInfo?.ollamaModel ?? 'Loading...'}</p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Storage Path</h3>
            <p className="text-[12px] text-ink-muted font-mono">
              {runtimeInfo?.storagePath ?? 'Loading...'}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">Storage</h3>
            <div className="rounded-xl border border-border-subtle bg-bg-accent px-4 py-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[12px] text-ink">Downloaded AI components</span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.downloadedComponentsBytes)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[12px] text-ink">Recordings and transcripts</span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.recordingsBytes)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[12px] text-ink">Logs</span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.logsBytes)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[12px] text-ink">Other local app data</span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.otherLocalDataBytes)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-2">
                  <span className="text-[12px] font-semibold text-ink">Total</span>
                  <span className="text-[12px] font-semibold text-ink">
                    {formatBytes(storageInfo?.totalBytes)}
                  </span>
                </div>
              </div>

              <p className="text-[12px] text-ink-muted mt-4">{uninstallGuidance}</p>

              <div className="flex flex-wrap gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => void handleRemoveDownloadedComponents()}
                  disabled={isRemovingDownloads || isResettingLocalData}
                  className="text-[12px] font-medium text-white bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
                >
                  {isRemovingDownloads
                    ? 'Removing Downloaded AI...'
                    : 'Remove Downloaded AI Components'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleResetLocalData()}
                  disabled={isResettingLocalData || isRemovingDownloads}
                  className="text-[12px] font-medium text-clay-dark bg-[#F8E7DE] px-4 py-2 rounded-lg hover:bg-[#F3D8CC] transition-colors disabled:opacity-50"
                >
                  {isResettingLocalData ? 'Restarting AutoDoc...' : 'Delete All Local AutoDoc Data'}
                </button>
              </div>

              {storageNotice && <p className="text-[12px] text-sage mt-3">{storageNotice}</p>}
              {storageError && <p className="text-[12px] text-clay mt-3">{storageError}</p>}
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">About</h3>
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-ink-muted">AutoDoc v{appVersion}</span>
              {updateStatus.state === 'idle' && (
                <button
                  onClick={() => window.electronAPI.invoke('updater:check')}
                  className="text-[11px] font-medium text-sage hover:text-sage-dark transition-colors"
                >
                  Check for updates
                </button>
              )}
              {updateStatus.state === 'checking' && (
                <span className="text-[11px] text-ink-faint animate-pulse">Checking...</span>
              )}
              {updateStatus.state === 'available' && (
                <span className="text-[11px] text-sage font-medium">
                  v{updateStatus.version} downloading...
                </span>
              )}
              {updateStatus.state === 'downloading' && (
                <span className="text-[11px] text-sage font-medium">
                  Downloading update... {updateStatus.percent}%
                </span>
              )}
              {updateStatus.state === 'downloaded' && (
                <button
                  onClick={() => {
                    trackEvent('update_install_requested', {
                      available_version: updateStatus.version ?? 'unknown'
                    })
                    void window.electronAPI.invoke('updater:install')
                  }}
                  className="text-[11px] font-semibold text-white bg-sage px-3 py-1 rounded-lg hover:bg-sage-dark transition-colors"
                >
                  Restart to update to v{updateStatus.version}
                </button>
              )}
              {updateStatus.state === 'error' && (
                <button
                  onClick={() => window.electronAPI.invoke('updater:check')}
                  className="text-[11px] font-medium text-clay hover:text-clay-dark transition-colors"
                >
                  Update Failed. Retry
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
