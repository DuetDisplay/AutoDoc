import { BrowserWindow, ipcMain } from 'electron'
import type { SegmentationService } from '../services/segmentation'
import type { OllamaManager } from '../services/ollama-manager'
import type { OllamaProvider } from '../services/llm'
import type { MeetingSegments, SegmentationStatus, OllamaSetupStatus } from '../../shared/types'
import { getE2EOllamaStatus, retryE2EOllamaSetup } from '../services/e2e-fixtures'

const isE2E = process.env.AUTODOC_E2E === '1'

export function registerLlmIpc(
  segmentationService: SegmentationService,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
  getOllamaSetupStatus: () => OllamaSetupStatus,
  ensureOllamaRunning: () => void,
): void {
  ipcMain.handle(
    'ollama:check-status',
    async (): Promise<boolean> => {
      if (isE2E) {
        return getE2EOllamaStatus().phase === 'ready'
      }

      const running = await ollamaManager.isServerRunning()
      if (!running) ensureOllamaRunning()
      return running
    }
  )

  ipcMain.handle(
    'ollama:get-model',
    (): string => {
      return ollamaProvider.getModel()
    }
  )

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

  ipcMain.handle(
    'segmentation:get-progress',
    (_event, meetingId: string): number | undefined => {
      return segmentationService.getProgress(meetingId)
    }
  )

  ipcMain.handle(
    'segmentation:get-segments',
    async (_event, meetingId: string): Promise<MeetingSegments | null> => {
      return segmentationService.getSegments(meetingId)
    }
  )

  ipcMain.handle(
    'segmentation:retry',
    async (_event, meetingId: string): Promise<void> => {
      segmentationService.retry(meetingId)
    }
  )

  ipcMain.handle(
    'segmentation:save-segments',
    async (_event, meetingId: string, segments: MeetingSegments): Promise<void> => {
      await segmentationService.saveSegments(meetingId, segments)
    }
  )

  ipcMain.handle(
    'ollama:get-setup-status',
    (): OllamaSetupStatus => {
      if (isE2E) {
        return getE2EOllamaStatus()
      }

      return getOllamaSetupStatus()
    }
  )

  ipcMain.handle(
    'ollama:retry-setup',
    async (): Promise<void> => {
      if (isE2E) {
        const nextStatus = retryE2EOllamaSetup()
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          win.webContents.send('ollama:setup-progress', nextStatus)
        }
        return
      }

      ensureOllamaRunning()
    }
  )
}
