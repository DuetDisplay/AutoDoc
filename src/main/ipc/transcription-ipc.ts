import { ipcMain } from 'electron'
import type { TranscriptionService } from '../services/transcription'
import type { Transcript, TranscriptionStatus } from '../../shared/types'

export function registerTranscriptionIpc(
  transcriptionService: TranscriptionService,
  onManualRetry?: (meetingId: string) => void
): void {
  ipcMain.handle(
    'transcription:get-status',
    async (_event, meetingId: string): Promise<TranscriptionStatus> => {
      return transcriptionService.getStatus(meetingId)
    }
  )

  ipcMain.handle('transcription:get-progress', (_event, meetingId: string): number | undefined => {
    return transcriptionService.getProgress(meetingId)
  })

  ipcMain.handle(
    'transcription:get-transcript',
    async (_event, meetingId: string): Promise<Transcript[]> => {
      return transcriptionService.getTranscript(meetingId)
    }
  )

  ipcMain.handle('transcription:retry', async (_event, meetingId: string): Promise<void> => {
    onManualRetry?.(meetingId)
    transcriptionService.retry(meetingId)
  })
}
