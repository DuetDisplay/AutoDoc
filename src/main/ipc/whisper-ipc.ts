import { BrowserWindow, ipcMain } from 'electron'
import type { WhisperManager } from '../services/whisper-manager'
import type { WhisperSetupStatus } from '../../shared/types'
import type {
  MeetingLanguageCode,
  MeetingLanguageEngineState,
  WindowsMeetingLanguageAvailabilityInfo,
  WindowsMultilingualEngineReadyInfo
} from '../../shared/meeting-language'
import {
  isMeetingLanguageAvailable,
  MEETING_LANGUAGE_DEFINITIONS,
  normalizeMeetingLanguage
} from '../../shared/meeting-language'
import {
  currentMeetingLanguageAvailability,
  restorePreviousMeetingLanguageIfWindowsLocked,
  restorePreviousMeetingLanguageOnLock,
  waitForWindowsNotesModel
} from '../services/meeting-language-availability'
import { getE2EWhisperStatus, retryE2EWhisperSetup } from '../services/e2e-fixtures'
import {
  ensureWindowsMultilingualEngineReady,
  getWindowsMeetingLanguageAvailability
} from '../services/windows-multilingual-readiness'

const isE2E = process.env.AUTODOC_E2E === '1'

const UNUSED_WINDOWS_LANGUAGE_AVAILABILITY: WindowsMeetingLanguageAvailabilityInfo = {
  availability: 'available',
  reason: null,
  engineId: null,
  firstUseDownloadBytes: 0,
  needsSelfTest: false
}

const UNUSED_WINDOWS_ENGINE_READY: WindowsMultilingualEngineReadyInfo = {
  engineId: null,
  availability: 'available',
  reason: null
}

export function registerWhisperIpc(
  whisperManager: WhisperManager,
  getWhisperSetupStatus: () => WhisperSetupStatus,
  retryTranscriptionSetup?: (language?: MeetingLanguageCode) => Promise<void>
): void {
  ipcMain.handle('whisper:get-meeting-language-states', async () => {
    const entries = await Promise.all(
      MEETING_LANGUAGE_DEFINITIONS.map(async ({ code }) => {
        const state: MeetingLanguageEngineState =
          process.platform === 'win32'
            ? await getWindowsMeetingLanguageAvailability(code)
            : await whisperManager.getMacMeetingLanguageState(code)
        return [code, state] as const
      })
    )
    return Object.fromEntries(entries)
  })

  ipcMain.handle(
    'whisper:prepare-meeting-language',
    async (_event, language: MeetingLanguageCode) => {
      await waitForWindowsNotesModel()
      if (!isMeetingLanguageAvailable(language, currentMeetingLanguageAvailability())) {
        throw new Error('This meeting language needs 16 GB of memory.')
      }
      if (retryTranscriptionSetup) await retryTranscriptionSetup(language)
      else await whisperManager.prepareMeetingLanguage(language)
    }
  )

  ipcMain.handle('whisper:get-setup-status', (): WhisperSetupStatus => {
    if (isE2E) {
      return getE2EWhisperStatus()
    }

    return getWhisperSetupStatus()
  })

  ipcMain.handle('whisper:retry-setup', async (): Promise<void> => {
    if (isE2E) {
      const nextStatus = retryE2EWhisperSetup()
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('whisper:setup-progress', nextStatus)
      }
      return
    }

    try {
      if (retryTranscriptionSetup) {
        await retryTranscriptionSetup()
      } else {
        await whisperManager.startSetup()
      }
    } catch (err) {
      console.error('Whisper retry failed:', err)
      if (err instanceof Error && err.name === 'MeetingLanguageSetupSuperseded') return
      // Every failed retry reports an error, so onboarding and Settings can
      // stop auto-retrying and show Retry even when the engine emitted none.
      const status = getWhisperSetupStatus()
      const failed: WhisperSetupStatus =
        status.phase === 'error'
          ? status
          : { phase: 'error', percent: 0, error: err instanceof Error ? err.message : String(err) }
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('whisper:setup-progress', failed)
      }
    }
  })

  ipcMain.handle(
    'whisper:get-windows-meeting-language-availability',
    async (_event, language: unknown): Promise<WindowsMeetingLanguageAvailabilityInfo> => {
      if (process.platform !== 'win32') {
        return UNUSED_WINDOWS_LANGUAGE_AVAILABILITY
      }
      return getWindowsMeetingLanguageAvailability(String(language ?? ''))
    }
  )

  ipcMain.handle(
    'whisper:ensure-windows-multilingual-engine',
    async (_event, language: unknown): Promise<WindowsMultilingualEngineReadyInfo> => {
      if (process.platform !== 'win32') {
        return UNUSED_WINDOWS_ENGINE_READY
      }
      const selected = normalizeMeetingLanguage(language)
      let ready
      try {
        ready = await ensureWindowsMultilingualEngineReady(selected)
      } catch (error) {
        await restorePreviousMeetingLanguageIfWindowsLocked(selected)
        throw error
      }
      if (ready.availability === 'locked' || !ready.engineId) {
        restorePreviousMeetingLanguageOnLock(selected)
      }
      return {
        engineId: ready.engineId,
        availability: ready.availability,
        reason: ready.reason,
        fallbackFrom: ready.fallbackFrom,
        fallbackReason: ready.fallbackReason
      }
    }
  )
}
