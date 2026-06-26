import { BrowserWindow, ipcMain } from 'electron'
import type { WhisperManager } from '../services/whisper-manager'
import type { WhisperSetupStatus } from '../../shared/types'
import { getE2EWhisperStatus, retryE2EWhisperSetup } from '../services/e2e-fixtures'

const isE2E = process.env.AUTODOC_E2E === '1'

export function registerWhisperIpc(
  whisperManager: WhisperManager,
  getWhisperSetupStatus: () => WhisperSetupStatus,
  retryTranscriptionSetup?: () => Promise<void>,
): void {
  ipcMain.handle(
    'whisper:get-setup-status',
    (): WhisperSetupStatus => {
      if (isE2E) {
        return getE2EWhisperStatus()
      }

      return getWhisperSetupStatus()
    },
  )

  ipcMain.handle(
    'whisper:retry-setup',
    async (): Promise<void> => {
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
    },
  )
}
