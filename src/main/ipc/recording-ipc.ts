// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import { RecordingService } from '../services/recording'
import type { RecordingSource, RecordingState } from '../../shared/types'

export function registerRecordingIpc(recordingService: RecordingService): void {
  ipcMain.handle('recording:get-sources', async (): Promise<RecordingSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
    })

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }))
  })

  ipcMain.handle('recording:start', async (_event, sourceId: string, sourceName: string) => {
    const paths = await recordingService.startRecording(sourceId, sourceName)
    broadcastState(recordingService.getState())
    return paths
  })

  ipcMain.handle('recording:stop', () => {
    const result = recordingService.stopRecording()
    broadcastState(recordingService.getState())
    return result
  })

  ipcMain.handle('recording:get-state', () => {
    return recordingService.getState()
  })

  ipcMain.handle(
    'recording:save-chunk',
    async (_event, meetingId: string, type: 'video' | 'audio', chunk: ArrayBuffer) => {
      const currentState = recordingService.getState()
      if (!currentState.isRecording || currentState.meetingId !== meetingId) {
        return // Ignore chunks for stale or mismatched recordings
      }
      const baseDir = recordingService.getRecordingsBaseDir()
      const filename = type === 'video' ? 'screen.webm' : 'audio.webm'
      const filePath = join(baseDir, meetingId, filename)
      await appendFile(filePath, Buffer.from(chunk))
    }
  )
}

function broadcastState(state: RecordingState): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('recording:status-changed', state)
  }
}
