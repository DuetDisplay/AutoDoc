import { BrowserWindow, ipcMain } from 'electron'
import type { WhisperManager } from '../services/whisper-manager'
import type { WhisperSetupStatus } from '../../shared/types'
import type {
  WindowsMeetingLanguageAvailabilityInfo,
  WindowsMultilingualEngineReadyInfo
} from '../../shared/meeting-language'
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
  retryTranscriptionSetup?: () => Promise<void>
): void {
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
      const ready = await ensureWindowsMultilingualEngineReady(String(language ?? ''))
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
