import { ipcMain } from 'electron'
import type { SegmentationService } from '../services/segmentation'
import type { OllamaManager } from '../services/ollama-manager'
import type { OllamaProvider } from '../services/llm'
import type { MeetingSegments, SegmentationStatus } from '../../shared/types'

export function registerLlmIpc(
  segmentationService: SegmentationService,
  ollamaManager: OllamaManager,
  ollamaProvider: OllamaProvider,
): void {
  ipcMain.handle(
    'ollama:check-status',
    async (): Promise<boolean> => {
      return ollamaManager.isServerRunning()
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
}
