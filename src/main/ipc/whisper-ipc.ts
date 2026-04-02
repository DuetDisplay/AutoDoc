import { ipcMain } from 'electron'
import type { WhisperManager } from '../services/whisper-manager'
import type { WhisperSetupStatus } from '../../shared/types'

export function registerWhisperIpc(
  whisperManager: WhisperManager,
  getWhisperSetupStatus: () => WhisperSetupStatus,
): void {
  ipcMain.handle(
    'whisper:get-setup-status',
    (): WhisperSetupStatus => {
      return getWhisperSetupStatus()
    },
  )

  ipcMain.handle(
    'whisper:retry-setup',
    async (): Promise<void> => {
      try {
        await whisperManager.startSetup()
      } catch (err) {
        console.error('Whisper retry failed:', err)
      }
    },
  )
}
