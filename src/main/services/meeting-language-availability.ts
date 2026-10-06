import { LOW_SPEC_MAC_OLLAMA_MODEL } from '../../shared/constants'
import {
  DEFAULT_MEETING_LANGUAGE,
  isEnglishMeetingLanguage,
  isMeetingLanguageAvailable,
  meetingLanguageAvailability,
  normalizeMeetingLanguage,
  type MeetingLanguageAvailability,
  type MeetingLanguageCode
} from '../../shared/meeting-language'
import { logAutodocEvent } from './autodoc-log'
import { macUsesSmallNotesModel } from './mac-processing-profile'
import {
  notesModelForWindowsProfile,
  type WindowsHardwareSnapshot,
  type WindowsProcessingProfileId
} from './windows-processing-profile'

export interface WindowsNotesModelProfile {
  id: WindowsProcessingProfileId
  hardware: WindowsHardwareSnapshot
}

type WindowsNotesModelSource = () => WindowsNotesModelProfile | null

let windowsNotesModelSource: WindowsNotesModelSource | null = null

export interface MeetingLanguagePreferenceStore {
  getMeetingLanguage(): MeetingLanguageCode
  restorePreviousMeetingLanguageIfCurrent(lockedLanguage: unknown): MeetingLanguageCode
}

let meetingLanguagePreferenceStore: MeetingLanguagePreferenceStore | null = null

/** Lets Settings and recording read the same notes-model decision Whisper already made. */
export function bindWindowsNotesModelSource(source: WindowsNotesModelSource): void {
  windowsNotesModelSource = source
}

export function bindMeetingLanguagePreferenceStore(
  store: MeetingLanguagePreferenceStore | null
): void {
  meetingLanguagePreferenceStore = store
}

/** Restore the last saved language when setup already reported a lock. */
export function restorePreviousMeetingLanguageOnLock(
  language: MeetingLanguageCode
): MeetingLanguageCode | null {
  const store = meetingLanguagePreferenceStore
  if (!store) return null
  const locked = normalizeMeetingLanguage(language)
  if (store.getMeetingLanguage() !== locked) return null
  return store.restorePreviousMeetingLanguageIfCurrent(locked)
}

/**
 * Restore only when Windows routing/self-test reports locked — not download or
 * other transient setup failures.
 */
export async function restorePreviousMeetingLanguageIfWindowsLocked(
  language: MeetingLanguageCode
): Promise<MeetingLanguageCode | null> {
  if (process.platform !== 'win32') return null
  try {
    const { getWindowsMeetingLanguageAvailability } = await import(
      './windows-multilingual-readiness'
    )
    const engine = await getWindowsMeetingLanguageAvailability(language)
    if (engine.availability !== 'locked') return null
  } catch {
    return null
  }
  return restorePreviousMeetingLanguageOnLock(language)
}

export function usesSmallNotesModel(options?: {
  platform?: NodeJS.Platform
  windowsProfile?: WindowsNotesModelProfile | null
}): boolean {
  const platform = options?.platform ?? process.platform
  if (platform === 'darwin') {
    return macUsesSmallNotesModel()
  }
  if (platform !== 'win32') {
    return false
  }

  const profile =
    options && 'windowsProfile' in options
      ? options.windowsProfile
      : (windowsNotesModelSource?.() ?? null)
  if (!profile) return false
  return notesModelForWindowsProfile(profile.id, profile.hardware) === LOW_SPEC_MAC_OLLAMA_MODEL
}

/** Meeting languages this machine's notes model can write. */
export function currentMeetingLanguageAvailability(
  options?: Parameters<typeof usesSmallNotesModel>[0]
): MeetingLanguageAvailability {
  return meetingLanguageAvailability(usesSmallNotesModel(options))
}

/**
 * The language a new recording uses: the saved preference, or English when
 * this machine's notes model does not support it (for example a preference
 * carried over from a larger Mac). Settings explains the fallback.
 */
export function recordingMeetingLanguage(
  saved: MeetingLanguageCode,
  availability: MeetingLanguageAvailability = currentMeetingLanguageAvailability()
): MeetingLanguageCode {
  if (isMeetingLanguageAvailable(saved, availability)) return saved
  logAutodocEvent({
    area: 'recording',
    message: 'saved meeting language unavailable on this machine; recording in English',
    context: { savedLanguage: saved }
  })
  return DEFAULT_MEETING_LANGUAGE
}

/**
 * Recording-start language, including Windows engine locks. Mac stays on the
 * sync notes-model list so its behavior is unchanged.
 */
export async function resolveRecordingMeetingLanguage(
  saved: MeetingLanguageCode,
  availability: MeetingLanguageAvailability = currentMeetingLanguageAvailability()
): Promise<MeetingLanguageCode> {
  if (process.platform !== 'win32' || isEnglishMeetingLanguage(saved)) {
    return recordingMeetingLanguage(saved, availability)
  }
  if (!isMeetingLanguageAvailable(saved, availability)) {
    return recordingMeetingLanguage(saved, availability)
  }

  try {
    const { getWindowsMeetingLanguageAvailability } = await import(
      './windows-multilingual-readiness'
    )
    const engine = await getWindowsMeetingLanguageAvailability(saved)
    if (engine.availability === 'locked') {
      return recordingMeetingLanguage(saved, {
        ...availability,
        languageStates: {
          ...availability.languageStates,
          [saved]: {
            availability: 'locked',
            reason: engine.reason,
            engineId: engine.engineId,
            firstUseDownloadBytes: engine.firstUseDownloadBytes,
            needsSelfTest: engine.needsSelfTest
          }
        }
      })
    }
  } catch {
    // Readiness is unbound in unit tests; keep the notes-model-only fallback.
  }

  return recordingMeetingLanguage(saved, availability)
}
