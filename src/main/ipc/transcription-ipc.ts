import { ipcMain } from 'electron'
import type { TranscriptionService } from '../services/transcription'
import type { Transcript, TranscriptionStatus } from '../../shared/types'
import { isMeetingLanguageCode, type MeetingLanguageCode } from '../../shared/meeting-language'

export interface ReprocessLanguageGuards {
  /** True while the recording is captured, saved, or post-processed. */
  isRecordingBusy: (meetingId: string) => boolean
  /** Why this computer cannot process a language, or null when it can. */
  getMeetingLanguageBlockReason: (language: MeetingLanguageCode) => Promise<string | null>
}

export function registerTranscriptionIpc(
  transcriptionService: TranscriptionService,
  onManualRetry?: (meetingId: string) => void,
  reprocessLanguageGuards?: ReprocessLanguageGuards
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

  ipcMain.handle('transcription:get-memory-failure', (_event, meetingId: string) => {
    return transcriptionService.getMemoryFailure(meetingId)
  })

  ipcMain.handle('transcription:get-error-code', (_event, meetingId: string) => {
    return transcriptionService.getErrorCode(meetingId)
  })

  ipcMain.handle('transcription:get-cpu-fallback', (_event, meetingId: string): boolean => {
    return transcriptionService.getCpuFallback(meetingId)
  })

  ipcMain.handle(
    'transcription:get-transcript',
    async (_event, meetingId: string): Promise<Transcript[]> => {
      return transcriptionService.getTranscript(meetingId)
    }
  )

  ipcMain.handle('transcription:get-reprocess-failure', async (_event, meetingId: string) => {
    return transcriptionService.getReprocessFailure(meetingId)
  })

  // With `meetingLanguage`, the transcript is redone in that language and the
  // recording adopts it once the transcript succeeds; a failure changes nothing.
  ipcMain.handle(
    'transcription:retry',
    async (
      _event,
      meetingId: string,
      options?: { reprocess?: boolean; meetingLanguage?: unknown }
    ): Promise<void> => {
      let meetingLanguage: MeetingLanguageCode | undefined
      if (options?.meetingLanguage !== undefined) {
        if (!isMeetingLanguageCode(options.meetingLanguage)) {
          throw new Error('This meeting language is not supported.')
        }
        meetingLanguage = options.meetingLanguage
        const busy = (): boolean =>
          (reprocessLanguageGuards?.isRecordingBusy(meetingId) ?? false) ||
          transcriptionService.isActiveJob(meetingId)
        const busyMessage =
          'The meeting language cannot be changed while the recording is saved or processed.'
        if (busy()) throw new Error(busyMessage)
        const blockReason =
          await reprocessLanguageGuards?.getMeetingLanguageBlockReason(meetingLanguage)
        if (blockReason) throw new Error(blockReason)
        // The availability check awaited; nothing else may run between this check and the retry.
        if (busy()) throw new Error(busyMessage)
      }
      onManualRetry?.(meetingId)
      // On Windows a plain retry keeps a usable transcript; a language change must replace it.
      const source =
        process.platform === 'win32' &&
        (options?.reprocess === true || meetingLanguage !== undefined)
          ? 'reprocess'
          : 'direct'
      const queued = transcriptionService.retry(meetingId, source, meetingLanguage)
      // A plain retry may be dropped silently (cooldown); a language change must not be.
      if (!queued && meetingLanguage) {
        throw new Error('The meeting could not be queued for reprocessing. Try again in a moment.')
      }
    }
  )
}
