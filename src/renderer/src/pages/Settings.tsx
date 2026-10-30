import { isDiskFullError } from '../../../shared/disk-full'
import { AUTODOC_GITHUB_URL } from '../../../shared/constants'
import type { MessageKey } from '../../../shared/i18n'
import { meetingLanguageName } from '../services/meeting-language-name'
import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { CALENDAR_CONNECT_BUTTON_CLASS } from '../components/ConnectCalendar'
import { PageHeader } from '../components/PageHeader'
import { SpeechLicenses } from '../components/SpeechLicenses'
import { MeetingLanguagePicker } from '../components/MeetingLanguagePicker'
import { UiLanguagePicker } from '../components/UiLanguagePicker'
import { useCalendarStore } from '../stores/calendar'
import { useRecordingStore } from '../stores/recording'
import { useCalendarConnect } from '../hooks/useCalendarConnect'
import type { UpdateStatus } from '../../../preload/ipc.d'
import type { AppRuntimeInfo, AppStorageInfo, CalendarAccount } from '../../../shared/types'
import {
  DEFAULT_MEETING_LANGUAGE,
  isMeetingLanguageAvailable,
  normalizeMeetingLanguage,
  UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode,
  type MeetingLanguageEngineState
} from '../../../shared/meeting-language'
import type { WhisperSetupStatus } from '../../../shared/types'
import { formatBytes, formatMeetingLanguageFirstUseDownload } from '../services/format-bytes'
import { loadMeetingLanguageStates } from '../services/meeting-language-setup'
import { getWhisperSetupLabel } from '../services/setup-status-labels'

import {
  identifyConsentedInstall,
  setAnalyticsConsent,
  startAnalyticsSession,
  trackConsentSnapshot,
  trackDailyActiveIfNeeded,
  trackEvent
} from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import { UpdateDiskFullAlert } from '../components/UpdateDiskFullAlert'
import { notifyManualUpdateCheckStarted } from '../services/update-check-events'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { isNetworkErrorMessage } from '../services/network-errors'
import { offlineMeetingLanguageMessage } from '../services/meeting-language-copy'
import { APPEARANCE_MODES } from '../../../shared/appearance'
import { UI_LANGUAGE_NATIVE_LABELS } from '../../../shared/ui-language'
import { useI18n } from '../services/i18n'
import { useAppearance } from '../services/theme'

const FeedbackPromptQASimulator = __AUTODOC_QA_BUILD__
  ? lazy(() =>
      import('../components/FeedbackPromptQASimulator').then((module) => ({
        default: module.FeedbackPromptQASimulator
      }))
    )
  : null

function getCalendarAccountLabel(
  account: CalendarAccount,
  t: (key: 'settings.googleAccount' | 'settings.microsoftAccount') => string
): string {
  const email = account.email.trim()
  if (email) {
    return email
  }

  return account.provider === 'google'
    ? t('settings.googleAccount')
    : t('settings.microsoftAccount')
}

function getCalendarSyncIssueMessage(
  account: CalendarAccount,
  t: (key: 'settings.syncUnsupportedMailbox' | 'settings.syncReconnectRequired') => string
): string | null {
  if (account.syncIssue === 'unsupported-mailbox') {
    return t('settings.syncUnsupportedMailbox')
  }
  if (account.syncIssue === 'reconnect-required') {
    return account.provider === 'google'
      ? 'Google Calendar needs to be reconnected to resume calendar sync. Disconnect it, then connect again and allow calendar access.'
      : 'Microsoft Outlook needs to be reconnected to resume calendar sync.'
  }

  return null
}

export function Settings() {
  const [githubOpenFailed, setGithubOpenFailed] = useState(false)
  const openGithub = () => {
    setGithubOpenFailed(false)
    void window.electronAPI
      .invoke('github-star:open')
      .then((opened) => setGithubOpenFailed(!opened))
      .catch(() => setGithubOpenFailed(true))
  }
  const { t, language: uiLanguage, setLanguage: setUiLanguage } = useI18n()
  const { appearance, setAppearance } = useAppearance()
  const [uiLanguageOffer, setUiLanguageOffer] = useState<MeetingLanguageCode | null>(null)
  const meetingLanguageSection = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focusLanguage = () => {
      const query = new URLSearchParams(window.location.hash.split('?')[1])
      if (query.get('section') === 'meeting-language') {
        meetingLanguageSection.current?.scrollIntoView({ block: 'center' })
        meetingLanguageSection.current?.focus({ preventScroll: true })
      }
    }
    focusLanguage()
    window.addEventListener('hashchange', focusLanguage)
    return () => window.removeEventListener('hashchange', focusLanguage)
  }, [])
  const online = useOnlineStatus()
  const { accounts, setAccounts, addAccount, removeAccount, setConnecting, setEvents } =
    useCalendarStore()
  const [showSpeechLicenses, setShowSpeechLicenses] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' })
  const isRecording = useRecordingStore((state) => state.isRecording)
  const installBlockedReason = isRecording
    ? 'Finish your recording before restarting.'
    : updateStatus.installBlockedReason
  const [runtimeInfo, setRuntimeInfo] = useState<AppRuntimeInfo | null>(null)
  const [storageInfo, setStorageInfo] = useState<AppStorageInfo | null>(null)
  const [analyticsConsent, setAnalyticsConsentState] = useState<boolean | null>(null)
  const [diagnosticLogUploadConsent, setDiagnosticLogUploadConsentState] = useState(false)
  const [videoWatermarkVisible, setVideoWatermarkVisibleState] = useState(true)
  const [meetingLanguage, setMeetingLanguageState] =
    useState<MeetingLanguageCode>(DEFAULT_MEETING_LANGUAGE)
  const [isSavingMeetingLanguage, setIsSavingMeetingLanguage] = useState(false)
  const [meetingLanguageFailure, setMeetingLanguageFailure] = useState<
    | { kind: 'save' | 'disk-full' }
    | { kind: 'locked'; language: MeetingLanguageCode }
    | {
        kind: 'offline'
        language: MeetingLanguageCode
        bytes?: number
        savedLanguage: MeetingLanguageCode | null
      }
    | null
  >(null)
  const [meetingLanguageAvailability, setMeetingLanguageAvailability] =
    useState<MeetingLanguageAvailability>(UNRESTRICTED_MEETING_LANGUAGE_AVAILABILITY)
  const [languageStates, setLanguageStates] = useState<
    Partial<Record<MeetingLanguageCode, MeetingLanguageEngineState>>
  >({})
  const [preparingMeetingLanguage, setPreparingMeetingLanguage] =
    useState<MeetingLanguageCode | null>(null)
  const [meetingLanguageSetupStatus, setMeetingLanguageSetupStatus] =
    useState<WhisperSetupStatus | null>(null)
  const [storageNotice, setStorageNotice] = useState<MessageKey | null>(null)
  const [storageError, setStorageError] = useState<MessageKey | null>(null)
  const [isRemovingDownloads, setIsRemovingDownloads] = useState(false)
  const [isResettingLocalData, setIsResettingLocalData] = useState(false)
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false)
  const previousUpdateState = useRef<UpdateStatus['state']>('idle')

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
    void window.electronAPI.invoke('prefs:get-video-watermark-visible').then(
      (visible) => {
        if (typeof visible === 'boolean') {
          setVideoWatermarkVisibleState(visible)
        }
      },
      () => undefined
    )
    void window.electronAPI.invoke('prefs:get-meeting-language').then(
      (language) => setMeetingLanguageState(normalizeMeetingLanguage(language)),
      () => undefined
    )
    void window.electronAPI.invoke('prefs:get-meeting-language-availability').then(
      (availability) => {
        if (availability) setMeetingLanguageAvailability(availability)
      },
      () => undefined
    )
    const unsub = window.electronAPI.on('updater:status', setUpdateStatus)
    const unsubConsent = window.electronAPI.on(
      'prefs:analytics-consent-changed',
      setAnalyticsConsentState
    )
    const unsubDiagnosticLogConsent = window.electronAPI.on(
      'prefs:diagnostic-log-upload-consent-changed',
      setDiagnosticLogUploadConsentState
    )
    const unsubVideoWatermarkVisible = window.electronAPI.on(
      'prefs:video-watermark-visible-changed',
      setVideoWatermarkVisibleState
    )
    return () => {
      unsub()
      unsubConsent()
      unsubDiagnosticLogConsent()
      unsubVideoWatermarkVisible()
    }
  }, [refreshStorageInfo])

  const isWindows = runtimeInfo?.platform === 'win32'

  const refreshLanguageStates = useCallback(async () => {
    if (!runtimeInfo?.platform) return
    try {
      setLanguageStates(await loadMeetingLanguageStates(runtimeInfo.platform))
    } catch {
      // Keep the last known engine states if a refresh fails.
    }
  }, [runtimeInfo?.platform])

  useEffect(() => {
    void refreshLanguageStates()
  }, [refreshLanguageStates])

  useEffect(() => {
    if (!preparingMeetingLanguage) {
      setMeetingLanguageSetupStatus(null)
      return
    }
    const unsub = window.electronAPI.on('whisper:setup-progress', (status) => {
      if (!status.meetingLanguage || status.meetingLanguage === preparingMeetingLanguage) {
        setMeetingLanguageSetupStatus(status)
      }
    })
    return unsub
  }, [preparingMeetingLanguage])

  useEffect(() => {
    const previousState = previousUpdateState.current
    previousUpdateState.current = updateStatus.state

    if (updateStatus.state !== 'installing') {
      setIsInstallingUpdate(false)
    }

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
      trackEvent('update_download_started', {
        available_version: updateStatus.version ?? 'unknown'
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

  const handleCheckForUpdates = () => {
    notifyManualUpdateCheckStarted()
    void window.electronAPI.invoke('updater:check')
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
    await setAnalyticsConsent(nextValue)
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

  const handleToggleVideoWatermark = async (): Promise<void> => {
    const nextValue = !videoWatermarkVisible
    recordDiagnosticAction({
      category: 'settings',
      action: 'video_watermark_visibility_toggled',
      details: { visible: nextValue }
    })
    await window.electronAPI.invoke('prefs:set-video-watermark-visible', nextValue)
    setVideoWatermarkVisibleState(nextValue)
  }

  const handleSetMeetingLanguage = async (language: MeetingLanguageCode): Promise<void> => {
    setMeetingLanguageFailure(null)
    setIsSavingMeetingLanguage(true)
    try {
      if (isWindows && language !== DEFAULT_MEETING_LANGUAGE) {
        let engineState = languageStates[language]
        if (!engineState) {
          const fetched = await window.electronAPI.invoke(
            'whisper:get-windows-meeting-language-availability',
            language
          )
          if (fetched) {
            engineState = fetched
            setLanguageStates((current) => ({ ...current, [language]: fetched }))
          }
        }
        if (engineState?.availability === 'locked') {
          setMeetingLanguageFailure({ kind: 'locked', language })
          return
        }
        const needsEnsure =
          (engineState?.firstUseDownloadBytes ?? 0) > 0 || engineState?.needsSelfTest === true
        if (needsEnsure) {
          setPreparingMeetingLanguage(language)
          try {
            // Same path as onboarding, so setup status reports ready afterwards.
            // It throws the lock reason when the engine turns out to be locked.
            await window.electronAPI.invoke('whisper:prepare-meeting-language', language)
          } finally {
            await refreshLanguageStates()
          }
        }
      } else if (runtimeInfo?.platform === 'darwin' || language === DEFAULT_MEETING_LANGUAGE) {
        setPreparingMeetingLanguage(language)
        setMeetingLanguageSetupStatus({ phase: 'checking', percent: 0 })
        await window.electronAPI.invoke('whisper:prepare-meeting-language', language)
      }
      await window.electronAPI.invoke('prefs:set-meeting-language', language)
      setMeetingLanguageState(language)
      setUiLanguageOffer(language !== uiLanguage ? language : null)
      recordDiagnosticAction({
        category: 'settings',
        action: 'meeting_language_changed',
        details: { language }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.saveMeetingLanguageFailed')
      let savedLanguage: MeetingLanguageCode | null = null
      try {
        savedLanguage = normalizeMeetingLanguage(
          await window.electronAPI.invoke('prefs:get-meeting-language')
        )
        setMeetingLanguageState(savedLanguage)
      } catch {
        // Keep the last picker value if the saved preference cannot be read.
      }
      setMeetingLanguageFailure(
        isDiskFullError(err)
          ? { kind: 'disk-full' }
          : isNetworkErrorMessage(message)
            ? {
                kind: 'offline',
                language,
                bytes: languageStates[language]?.firstUseDownloadBytes,
                savedLanguage
              }
            : { kind: 'save' }
      )
    } finally {
      if (!isWindows) await refreshLanguageStates()
      setPreparingMeetingLanguage(null)
      setMeetingLanguageSetupStatus(null)
      setIsSavingMeetingLanguage(false)
    }
  }

  const handleRemoveDownloadedComponents = async () => {
    const confirmed = window.confirm(t('settings.removeDownloadsConfirm'))
    if (!confirmed) return

    setStorageNotice(null)
    setStorageError(null)
    setIsRemovingDownloads(true)
    try {
      const nextStorageInfo = await window.electronAPI.invoke('app:clear-downloaded-components')
      setStorageInfo(nextStorageInfo)
      setStorageNotice('settings.removeDownloadsDone')
    } catch {
      setStorageError('settings.removeDownloadsFailed')
    } finally {
      setIsRemovingDownloads(false)
    }
  }

  const handleResetLocalData = async () => {
    const confirmed = window.confirm(t('settings.deleteAllDataConfirm'))
    if (!confirmed) return

    setStorageNotice(null)
    setStorageError(null)
    setIsResettingLocalData(true)
    try {
      await window.electronAPI.invoke('app:reset-local-data')
      setStorageNotice('settings.deleteAllDataRestarting')
    } catch {
      setIsResettingLocalData(false)
      setStorageError('settings.deleteAllDataFailed')
    }
  }

  const meetingLanguageError = !meetingLanguageFailure
    ? null
    : meetingLanguageFailure.kind === 'offline'
      ? offlineMeetingLanguageMessage(
          meetingLanguageName(meetingLanguageFailure.language, uiLanguage),
          meetingLanguageFailure.bytes,
          meetingLanguageFailure.savedLanguage
            ? meetingLanguageName(meetingLanguageFailure.savedLanguage, uiLanguage)
            : null
        )
      : meetingLanguageFailure.kind === 'locked'
        ? t('settings.meetingLanguageUnavailable', {
            language: meetingLanguageName(meetingLanguageFailure.language, uiLanguage),
            machine: t('machine.pc')
          })
        : meetingLanguageFailure.kind === 'disk-full'
          ? t('ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')
          : t('settings.saveMeetingLanguageFailed')

  const uninstallGuidance =
    runtimeInfo?.platform === 'win32'
      ? t('settings.uninstallGuidanceWindows')
      : t('settings.uninstallGuidanceMac')

  const machineNoun = isWindows ? t('machine.pc') : t('machine.mac')
  const offeredLanguageLabel = uiLanguageOffer ? UI_LANGUAGE_NATIVE_LABELS[uiLanguageOffer] : ''
  const pickerAvailability: MeetingLanguageAvailability = {
    ...meetingLanguageAvailability,
    languageStates
  }
  const sizeLanguage = preparingMeetingLanguage ?? meetingLanguage
  const firstUseDownloadLabel = formatMeetingLanguageFirstUseDownload(
    languageStates[sizeLanguage]?.firstUseDownloadBytes ?? 0
  )
  const meetingLanguageSetupLabel = getWhisperSetupLabel(meetingLanguageSetupStatus, t)

  return (
    <div className="flex flex-col h-full">
      <PageHeader title={t('settings.title')} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-col gap-6 min-h-full">
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('appearance.title')}</h3>
            <div className="i18n-setting-row rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <p className="i18n-setting-copy text-[12px] text-ink-muted leading-relaxed text-pretty">
                {t('appearance.description')}
              </p>
              <div
                className="i18n-setting-control inline-flex flex-wrap rounded-lg border border-border-subtle bg-bg-card p-0.5"
                role="group"
                aria-label={t('appearance.title')}
              >
                {APPEARANCE_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={appearance === mode}
                    onClick={() => void setAppearance(mode)}
                    className={`i18n-btn px-3 py-1.5 rounded-md text-[12px] font-medium leading-snug transition-colors ${
                      appearance === mode
                        ? 'bg-sage text-on-brand'
                        : 'text-ink-muted hover:text-ink hover:bg-bg-accent'
                    }`}
                  >
                    {t(`appearance.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('uiLanguage.title')}</h3>
            <div className="i18n-setting-row rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <p className="i18n-setting-copy text-[12px] text-ink-muted leading-relaxed text-pretty">
                {t('uiLanguage.description')}
              </p>
              <UiLanguagePicker
                value={uiLanguage}
                label={t('uiLanguage.title')}
                onChange={(next) => {
                  setUiLanguageOffer(null)
                  void setUiLanguage(next)
                }}
              />
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.calendars')}</h3>

            {accounts.length > 0 && (
              <div className="flex flex-col gap-2 mb-3">
                {accounts.map((account) => (
                  <div key={account.id} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-3 min-w-0">
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
                      <span className="min-w-0 flex-1 text-[12px] text-ink-muted [overflow-wrap:anywhere]">
                        {getCalendarAccountLabel(account, t)}
                      </span>
                      <button
                        onClick={() => handleDisconnect(account.id)}
                        className="i18n-btn text-[12px] font-medium leading-snug text-ink-muted bg-bg-accent px-3 py-1.5 rounded-lg border border-border-subtle hover:border-ink-muted transition-colors"
                      >
                        {t('settings.disconnect')}
                      </button>
                    </div>
                    {getCalendarSyncIssueMessage(account, t) && (
                      <p className="text-[11px] text-clay-dark ml-[26px] text-pretty">
                        {getCalendarSyncIssueMessage(account, t)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => handleConnect('google')}
                disabled={connectingProvider !== null}
                className={CALENDAR_CONNECT_BUTTON_CLASS}
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
                {connectingProvider === 'google'
                  ? t('settings.connecting')
                  : t('settings.addGoogle')}
              </button>
              <button
                onClick={() => handleConnect('microsoft')}
                disabled={connectingProvider !== null}
                className={CALENDAR_CONNECT_BUTTON_CLASS}
              >
                <svg width="14" height="14" viewBox="0 0 23 23" fill="none">
                  <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                  <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
                  <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
                  <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
                </svg>
                {connectingProvider === 'microsoft'
                  ? t('settings.connecting')
                  : t('settings.addMicrosoft')}
              </button>
            </div>
          </div>
          <div
            ref={meetingLanguageSection}
            tabIndex={-1}
            aria-label={t('settings.meetingLanguageAria')}
          >
            <h3 className="text-[13px] font-semibold text-ink mb-2">
              {t('settings.meetingLanguage')}
            </h3>
            <div className="i18n-setting-row rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <div className="i18n-setting-copy">
                <p className="text-[12px] text-ink-muted leading-relaxed text-pretty">
                  {t('settings.meetingLanguageDescription')}
                </p>
                {meetingLanguageAvailability.restricted && (
                  <p className="mt-2 text-[11px] text-ink-muted leading-relaxed text-pretty">
                    {isWindows
                      ? t('settings.meetingLanguageRestrictedWindows')
                      : t('settings.meetingLanguageRestrictedMac')}
                  </p>
                )}
                {!isMeetingLanguageAvailable(meetingLanguage, pickerAvailability) && (
                  <p role="status" className="mt-1 text-[11px] text-clay-dark text-pretty">
                    {t('settings.meetingLanguageUnavailable', {
                      language: meetingLanguageName(meetingLanguage),
                      machine: machineNoun
                    })}
                  </p>
                )}
                {firstUseDownloadLabel && (
                  <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
                    {firstUseDownloadLabel}
                  </p>
                )}
                {meetingLanguageSetupLabel && (
                  <p role="status" className="mt-1 text-[11px] text-ink-muted leading-relaxed">
                    {meetingLanguageSetupLabel}
                  </p>
                )}
                {meetingLanguageError && (
                  <p role="alert" className="mt-1 text-[11px] text-clay-dark text-pretty">
                    {meetingLanguageError}
                  </p>
                )}
                {uiLanguageOffer && (
                  <div className="mt-3 rounded-lg border border-sage/30 bg-sage-light px-3 py-2.5">
                    <p className="text-[12px] font-semibold text-ink text-pretty">
                      {t('uiLanguage.offerTitle', { language: offeredLanguageLabel })}
                    </p>
                    <p className="mt-1 text-[12px] text-ink-muted leading-relaxed text-pretty">
                      {t('uiLanguage.offerBody', { language: offeredLanguageLabel })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void setUiLanguage(uiLanguageOffer)
                          setUiLanguageOffer(null)
                        }}
                        className="i18n-btn rounded-lg bg-sage px-3 py-1.5 text-[12px] font-medium leading-snug text-on-brand"
                      >
                        {t('uiLanguage.offerConfirm', { language: offeredLanguageLabel })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setUiLanguageOffer(null)}
                        className="rounded-lg border border-border-subtle bg-bg-card px-3 py-1.5 text-[12px] font-medium leading-snug text-ink-muted"
                      >
                        {t('uiLanguage.offerKeep')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="i18n-setting-control">
                <MeetingLanguagePicker
                  value={meetingLanguage}
                  disabled={isSavingMeetingLanguage || !runtimeInfo}
                  availability={pickerAvailability}
                  offline={!online}
                  onChange={(language) => void handleSetMeetingLanguage(language)}
                />
              </div>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">
              {t('settings.videoPlayback')}
            </h3>
            <div className="i18n-setting-row rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <div className="i18n-setting-copy">
                <p className="text-[12px] font-semibold text-ink text-pretty">
                  {t('settings.watermarkTitle')}
                </p>
                <p className="mt-0.5 text-[12px] text-ink-muted text-pretty">
                  {t('settings.watermarkDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleToggleVideoWatermark()}
                className={`i18n-setting-control relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors ${videoWatermarkVisible ? 'bg-sage' : 'bg-control-track-off'}`}
                aria-pressed={videoWatermarkVisible}
                aria-label={t('settings.watermarkAria')}
              >
                <span
                  className={`block h-5 w-5 rounded-full transition-transform ${videoWatermarkVisible ? 'translate-x-5 bg-control-thumb-on' : 'translate-x-0 bg-control-thumb'}`}
                />
              </button>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.analytics')}</h3>
            <div className="i18n-setting-row rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <div className="i18n-setting-copy">
                <p className="text-[12px] text-ink-muted text-pretty">
                  {t('settings.analyticsDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleToggleAnalytics()}
                className={`i18n-setting-control relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors ${analyticsConsent ? 'bg-sage' : 'bg-control-track-off'}`}
                aria-pressed={analyticsConsent === true}
                aria-label={t('settings.analyticsAria')}
              >
                <span
                  className={`block h-5 w-5 rounded-full transition-transform ${analyticsConsent ? 'translate-x-5 bg-control-thumb-on' : 'translate-x-0 bg-control-thumb'}`}
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
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-subtle text-sage focus:ring-sage disabled:opacity-50"
                  aria-label={t('settings.diagnosticLogsAria')}
                />
                <span className="min-w-0 text-[12px] text-ink-muted leading-relaxed text-pretty">
                  <strong className="text-ink font-semibold">
                    {t('settings.diagnosticLogsTitle')}
                  </strong>
                  <span className="mt-1 block">{t('ui.optionalDiagnosticLogUpload')}</span>
                </span>
              </label>
            </div>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">
              {t('settings.whisperModel')}
            </h3>
            <p className="text-[12px] text-ink-muted [overflow-wrap:anywhere]">
              {runtimeInfo?.whisperModel ?? t('settings.loading')}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.ollamaModel')}</h3>
            <p className="text-[12px] text-ink-muted [overflow-wrap:anywhere]">
              {runtimeInfo?.ollamaModel ?? t('settings.loading')}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.storagePath')}</h3>
            <p className="text-[12px] text-ink-muted font-mono [overflow-wrap:anywhere]">
              {runtimeInfo?.storagePath ?? t('settings.loading')}
            </p>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.storage')}</h3>
            <div className="rounded-xl border border-border-subtle bg-bg-accent px-4 py-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 text-[12px] text-ink text-pretty">
                    {t('settings.downloadedComponents')}
                  </span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.downloadedComponentsBytes)}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 text-[12px] text-ink text-pretty">
                    {t('settings.recordingsAndTranscripts')}
                  </span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.recordingsBytes)}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 text-[12px] text-ink text-pretty">
                    {t('settings.logs')}
                  </span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.logsBytes)}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 text-[12px] text-ink text-pretty">
                    {t('settings.otherLocalData')}
                  </span>
                  <span className="text-[12px] font-medium text-ink">
                    {formatBytes(storageInfo?.otherLocalDataBytes)}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border-subtle pt-2">
                  <span className="min-w-0 text-[12px] font-semibold text-ink text-pretty">
                    {t('settings.total')}
                  </span>
                  <span className="text-[12px] font-semibold text-ink">
                    {formatBytes(storageInfo?.totalBytes)}
                  </span>
                </div>
              </div>

              <p className="text-[12px] text-ink-muted mt-4 text-pretty">{uninstallGuidance}</p>

              <div className="flex flex-wrap gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => void handleRemoveDownloadedComponents()}
                  disabled={isRemovingDownloads || isResettingLocalData}
                  className="i18n-btn text-[12px] font-medium leading-snug text-on-ink bg-ink px-4 py-2 rounded-lg hover:bg-ink-secondary transition-colors disabled:opacity-50"
                >
                  {isRemovingDownloads
                    ? t('settings.removingDownloads')
                    : t('settings.removeDownloads')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleResetLocalData()}
                  disabled={isResettingLocalData || isRemovingDownloads}
                  className="text-[12px] font-medium leading-snug text-clay-dark bg-clay-light px-4 py-2 rounded-lg hover:bg-clay-light/80 transition-colors disabled:opacity-50"
                >
                  {isResettingLocalData
                    ? t('settings.deletingAllData')
                    : t('settings.deleteAllData')}
                </button>
              </div>

              {storageNotice && (
                <p role="status" className="text-[12px] text-sage-dark mt-3 text-pretty">
                  {t(storageNotice)}
                </p>
              )}
              {storageError && (
                <p role="alert" className="text-[12px] text-clay-dark mt-3 text-pretty">
                  {t(storageError)}
                </p>
              )}
            </div>
          </div>
          {FeedbackPromptQASimulator && runtimeInfo?.qaBuild && (
            <Suspense
              fallback={<p className="text-[12px] text-ink-muted">{t('settings.loadingQa')}</p>}
            >
              <FeedbackPromptQASimulator />
            </Suspense>
          )}
          <div>
            <h3 className="text-[13px] font-semibold text-ink mb-2">{t('settings.about')}</h3>
            <button
              type="button"
              aria-expanded={showSpeechLicenses}
              aria-controls="speech-licenses"
              onClick={() => setShowSpeechLicenses((open) => !open)}
              className="mb-3 text-[12px] font-medium text-sage-dark underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
            >
              {t('settings.licenses')}
            </button>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-accent px-4 py-3">
              <a
                href={AUTODOC_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault()
                  openGithub()
                }}
                className="text-[12px] text-sage-dark underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
              >
                {t('githubStar.sourceCode')}
              </a>
              <a
                href={AUTODOC_GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault()
                  openGithub()
                }}
                className="text-[12px] font-medium text-sage-dark underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage"
              >
                {t('githubStar.starAutoDoc')}
              </a>
            </div>
            {githubOpenFailed && (
              <p role="alert" className="mb-3 text-[12px] text-clay-dark">
                {t('githubStar.openFailed')}
              </p>
            )}
            {showSpeechLicenses && runtimeInfo && (
              <div id="speech-licenses">
                <SpeechLicenses platform={runtimeInfo.platform} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[12px] text-ink-muted">
                {t('settings.version', { version: appVersion })}
              </span>
              {updateStatus.state === 'idle' && !__AUTODOC_QA_BUILD__ && (
                <button
                  onClick={handleCheckForUpdates}
                  className="text-[11px] font-medium text-sage hover:text-sage-dark transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage"
                >
                  {t('settings.checkForUpdates')}
                </button>
              )}
              {updateStatus.state === 'idle' && __AUTODOC_QA_BUILD__ && (
                <span className="text-[11px] text-ink-faint">
                  {t('settings.updatesDisabledQa')}
                </span>
              )}
              {updateStatus.state === 'checking' && (
                <span className="text-[11px] text-ink-faint">{t('settings.checking')}</span>
              )}
              {updateStatus.state === 'available' && (
                <span className="text-[11px] text-sage font-medium">
                  {t('settings.versionDownloading', { version: updateStatus.version ?? '' })}
                </span>
              )}
              {updateStatus.state === 'downloading' && (
                <span className="text-[11px] text-sage font-medium">
                  {t('settings.downloadingUpdate', { percent: updateStatus.percent ?? 0 })}
                </span>
              )}
              {updateStatus.state === 'downloaded' && (
                <button
                  onClick={() => {
                    if (installBlockedReason) return
                    setIsInstallingUpdate(true)
                    trackEvent('update_install_requested', {
                      available_version: updateStatus.version ?? 'unknown'
                    })
                    void window.electronAPI.invoke('updater:install').then((result) => {
                      if (result?.blockedReason) {
                        setIsInstallingUpdate(false)
                        setUpdateStatus({
                          ...updateStatus,
                          installBlockedReason: result.blockedReason
                        })
                      }
                    })
                  }}
                  disabled={isInstallingUpdate || Boolean(installBlockedReason)}
                  className="i18n-btn text-[11px] font-semibold text-on-brand bg-sage px-3 py-1 rounded-lg hover:bg-sage-dark transition-colors"
                >
                  {isInstallingUpdate
                    ? t('settings.restarting')
                    : t('settings.restartToUpdate', { version: updateStatus.version ?? '' })}
                </button>
              )}
              {updateStatus.state === 'downloaded' && installBlockedReason && (
                <span role="status" className="text-[11px] text-ink-muted">
                  {installBlockedReason}
                </span>
              )}
              {updateStatus.state === 'installing' && (
                <span className="text-[11px] text-sage font-medium">
                  {t('settings.restarting')}
                </span>
              )}
              {updateStatus.state === 'error' && updateStatus.errorKind !== 'disk-full' && (
                <button
                  onClick={handleCheckForUpdates}
                  className="text-[11px] font-medium text-clay hover:text-clay-dark transition-colors"
                >
                  {t('settings.updateFailed')}
                </button>
              )}
            </div>
            {updateStatus.state === 'error' && updateStatus.errorKind === 'disk-full' && (
              <div className="mt-3">
                <UpdateDiskFullAlert variant="card" onTryAgain={handleCheckForUpdates} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
