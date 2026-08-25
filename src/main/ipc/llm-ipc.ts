import { BrowserWindow, ipcMain } from 'electron'
import type { SegmentationService } from '../services/segmentation'
import type { OllamaManager } from '../services/ollama-manager'
import type { OllamaProvider } from '../services/llm'
import type {
  MeetingNotesContent,
  MeetingNotesV2,
  MeetingSegments,
  NotesRevision,
  SegmentationActivity,
  SegmentationStatus,
  OllamaSetupStatus
} from '../../shared/types'
import { NotesRepository } from '../services/notes-repository'
import { getE2EOllamaStatus, retryE2EOllamaSetup } from '../services/e2e-fixtures'

const isE2E = process.env.AUTODOC_E2E === '1'
const UNHEALTHY_OLLAMA_RESTART_AFTER = 2
let consecutiveOllamaHealthFailures = 0

export function registerLlmIpc(
  segmentationService: SegmentationService,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
  getOllamaSetupStatus: () => OllamaSetupStatus,
  ensureOllamaRunning: (options?: { force?: boolean }) => void,
  startSetupFromStatusCheck = true,
  onManualSegmentationRetry?: (meetingId: string) => void,
  recordingsBaseDir?: string
): void {
  consecutiveOllamaHealthFailures = 0
  ipcMain.handle('ollama:check-status', async (): Promise<boolean> => {
    if (isE2E) {
      return getE2EOllamaStatus().phase === 'ready'
    }

    const running = await ollamaManager.isServerRunning()
    if (running) {
      consecutiveOllamaHealthFailures = 0
      return true
    }

    consecutiveOllamaHealthFailures += 1
    const setupAlreadyFinished = getOllamaSetupStatus().phase === 'ready'
    if (startSetupFromStatusCheck) {
      // Windows caches startAndPull as already done. A hung serve still listens,
      // so a plain ensureRunning() is a no-op. After two failed polls, force a
      // replace instead of leaving the sidebar disconnected.
      ensureOllamaRunning(
        consecutiveOllamaHealthFailures >= UNHEALTHY_OLLAMA_RESTART_AFTER
          ? { force: true }
          : undefined
      )
    } else if (
      setupAlreadyFinished &&
      consecutiveOllamaHealthFailures >= UNHEALTHY_OLLAMA_RESTART_AFTER
    ) {
      // Coordinated Windows setup already finished. Status checks stay passive
      // during the first download so they do not abort an in-flight pull, but
      // a later dead serve will never recover from the cached ready promise.
      ensureOllamaRunning({ force: true })
    }
    return false
  })

  ipcMain.handle('ollama:get-model', (): string => {
    return ollamaProvider.getModel()
  })

  ipcMain.handle(
    'segmentation:get-status',
    async (_event, meetingId: string): Promise<SegmentationStatus> => {
      return segmentationService.getStatus(meetingId)
    }
  )

  ipcMain.handle(
    'segmentation:get-error-code',
    async (_event, meetingId: string): Promise<string | undefined> => {
      return segmentationService.getErrorCode(meetingId)
    }
  )

  ipcMain.handle('segmentation:get-progress', (_event, meetingId: string): number | undefined => {
    return segmentationService.getProgress(meetingId)
  })

  ipcMain.handle(
    'segmentation:get-activity',
    (_event, meetingId: string): SegmentationActivity | null => {
      return segmentationService.getActivity(meetingId)
    }
  )

  ipcMain.handle(
    'segmentation:get-segments',
    async (_event, meetingId: string): Promise<MeetingSegments | null> => {
      return segmentationService.getSegments(meetingId)
    }
  )

  ipcMain.handle('segmentation:retry', async (_event, meetingId: string): Promise<void> => {
    try {
      onManualSegmentationRetry?.(meetingId)
    } catch (err) {
      console.warn('Manual segmentation retry callback failed:', err)
    }
    segmentationService.retry(meetingId)
  })

  ipcMain.handle(
    'segmentation:save-segments',
    async (_event, meetingId: string, segments: MeetingSegments): Promise<void> => {
      await segmentationService.saveSegments(meetingId, segments)
    }
  )

  if (recordingsBaseDir) {
    const notesRepository = new NotesRepository(recordingsBaseDir)

    ipcMain.handle(
      'notes:get-v2',
      async (_event, meetingId: string): Promise<MeetingNotesV2 | null> => {
        return notesRepository.readV2(meetingId)
      }
    )

    ipcMain.handle(
      'notes:set-next-step-completed',
      async (
        _event,
        meetingId: string,
        itemId: string,
        completed: boolean
      ): Promise<MeetingNotesV2 | null> => {
        const current = await notesRepository.readV2(meetingId)
        if (!current) return null
        const nextSteps = current.nextSteps.map((item) =>
          item.id === itemId ? { ...item, completed } : item
        )
        return notesRepository.writeV2(
          meetingId,
          {
            overview: current.overview,
            keyTakeaways: current.keyTakeaways,
            sections: current.sections,
            decisions: current.decisions,
            nextSteps
          },
          {
            expectedRevision: current.revision,
            sourceTranscriptRevision: current.sourceTranscriptRevision,
            sourceAttributionRevision: current.sourceAttributionRevision
          }
        )
      }
    )

    ipcMain.handle(
      'notes:write-v2',
      async (
        _event,
        meetingId: string,
        content: MeetingNotesContent,
        expectedRevision: NotesRevision
      ): Promise<MeetingNotesV2> => {
        const current = await notesRepository.readV2(meetingId)
        if (!current) {
          throw new Error('Notes are not available to edit')
        }
        return notesRepository.writeV2(meetingId, content, {
          expectedRevision,
          sourceTranscriptRevision: current.sourceTranscriptRevision,
          sourceAttributionRevision: current.sourceAttributionRevision
        })
      }
    )
  }

  ipcMain.handle('ollama:get-setup-status', (): OllamaSetupStatus => {
    if (isE2E) {
      return getE2EOllamaStatus()
    }

    return getOllamaSetupStatus()
  })

  ipcMain.handle('ollama:retry-setup', async (): Promise<void> => {
    if (isE2E) {
      const nextStatus = retryE2EOllamaSetup()
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('ollama:setup-progress', nextStatus)
      }
      return
    }

    ensureOllamaRunning({ force: true })
  })
}
