import { useCallback, useEffect, useState } from 'react'
import { isDiskFullError } from '../../../shared/disk-full'
import type { MessageKey } from '../../../shared/i18n'
import {
  DEFAULT_MEETING_LANGUAGE,
  type MeetingLanguageCode,
  type MeetingLanguageEngineState
} from '../../../shared/meeting-language'
import type { WhisperSetupStatus } from '../../../shared/types'
import type { UiLanguageCode } from '../../../shared/ui-language'
import { offlineMeetingLanguageMessage } from '../services/meeting-language-copy'
import { meetingLanguageName } from '../services/meeting-language-name'
import { loadMeetingLanguageStates } from '../services/meeting-language-setup'
import { isNetworkErrorMessage } from '../services/network-errors'

export type MeetingLanguageEngineStates = Partial<
  Record<MeetingLanguageCode, MeetingLanguageEngineState>
>

/** Why a meeting language could not be prepared or saved, for the copy shown under a picker. */
export type MeetingLanguageFailure =
  | { kind: 'save' | 'disk-full' }
  | { kind: 'locked'; language: MeetingLanguageCode }
  | {
      kind: 'offline'
      language: MeetingLanguageCode
      bytes?: number
      /** The language that still applies, named in the message when known. */
      savedLanguage: MeetingLanguageCode | null
    }

/** Windows reported the language locked before any download started. */
export class MeetingLanguageLockedError extends Error {
  constructor(readonly language: MeetingLanguageCode) {
    super(`Meeting language ${language} is locked on this PC.`)
    this.name = 'MeetingLanguageLockedError'
  }
}

export function classifyMeetingLanguageFailure(
  error: unknown,
  language: MeetingLanguageCode,
  firstUseDownloadBytes: number | undefined,
  savedLanguage: MeetingLanguageCode | null
): MeetingLanguageFailure {
  if (error instanceof MeetingLanguageLockedError) return { kind: 'locked', language }
  if (isDiskFullError(error)) return { kind: 'disk-full' }
  if (isNetworkErrorMessage(error instanceof Error ? error.message : null)) {
    return { kind: 'offline', language, bytes: firstUseDownloadBytes, savedLanguage }
  }
  return { kind: 'save' }
}

export function meetingLanguageFailureMessage(
  failure: MeetingLanguageFailure,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  uiLanguage: UiLanguageCode
): string {
  switch (failure.kind) {
    case 'offline':
      return offlineMeetingLanguageMessage(
        meetingLanguageName(failure.language, uiLanguage),
        failure.bytes,
        failure.savedLanguage ? meetingLanguageName(failure.savedLanguage, uiLanguage) : null
      )
    case 'locked':
      return t('settings.meetingLanguageUnavailable', {
        language: meetingLanguageName(failure.language, uiLanguage),
        machine: t('machine.pc')
      })
    case 'disk-full':
      return t('ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')
    default:
      return t('settings.saveMeetingLanguageFailed')
  }
}

/**
 * Gets a meeting language ready on this computer before it is saved anywhere:
 * the engine states for the picker, and a `prepareMeetingLanguage` that runs
 * the same checks and downloads whether the language is chosen globally in
 * Settings or for one recording in its Reprocess section.
 */
export function useMeetingLanguagePreparation(platform: string | null | undefined): {
  languageStates: MeetingLanguageEngineStates
  refreshLanguageStates: () => Promise<void>
  /** Language whose engine is being checked or downloaded right now. */
  preparingLanguage: MeetingLanguageCode | null
  setupStatus: WhisperSetupStatus | null
  /** Resolves once the language can be used; rejects with the reason it cannot. */
  prepareMeetingLanguage: (language: MeetingLanguageCode) => Promise<void>
} {
  const [languageStates, setLanguageStates] = useState<MeetingLanguageEngineStates>({})
  const [preparingLanguage, setPreparingLanguage] = useState<MeetingLanguageCode | null>(null)
  const [setupStatus, setSetupStatus] = useState<WhisperSetupStatus | null>(null)

  const refreshLanguageStates = useCallback(async () => {
    if (!platform) return
    try {
      setLanguageStates(await loadMeetingLanguageStates(platform))
    } catch {
      // Keep the last known engine states if a refresh fails.
    }
  }, [platform])

  useEffect(() => {
    void refreshLanguageStates()
  }, [refreshLanguageStates])

  useEffect(() => {
    if (!preparingLanguage) {
      setSetupStatus(null)
      return
    }
    const unsub = window.electronAPI.on('whisper:setup-progress', (status) => {
      if (!status.meetingLanguage || status.meetingLanguage === preparingLanguage) {
        setSetupStatus(status)
      }
    })
    return unsub
  }, [preparingLanguage])

  const prepareMeetingLanguage = useCallback(
    async (language: MeetingLanguageCode): Promise<void> => {
      const isWindows = platform === 'win32'
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
          if (engineState?.availability === 'locked') throw new MeetingLanguageLockedError(language)
          const needsEnsure =
            (engineState?.firstUseDownloadBytes ?? 0) > 0 || engineState?.needsSelfTest === true
          if (needsEnsure) {
            setPreparingLanguage(language)
            try {
              // Same path as onboarding, so setup status reports ready afterwards.
              // It throws the lock reason when the engine turns out to be locked.
              await window.electronAPI.invoke('whisper:prepare-meeting-language', language)
            } finally {
              await refreshLanguageStates()
            }
          }
        } else if (platform === 'darwin' || language === DEFAULT_MEETING_LANGUAGE) {
          setPreparingLanguage(language)
          setSetupStatus({ phase: 'checking', percent: 0 })
          await window.electronAPI.invoke('whisper:prepare-meeting-language', language)
        }
      } finally {
        if (!isWindows) await refreshLanguageStates()
        setPreparingLanguage(null)
        setSetupStatus(null)
      }
    },
    [platform, languageStates, refreshLanguageStates]
  )

  return {
    languageStates,
    refreshLanguageStates,
    preparingLanguage,
    setupStatus,
    prepareMeetingLanguage
  }
}
