// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile, readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { RecordingService } from '../services/recording'
import { TranscriptionService } from '../services/transcription'
import { encryptFileInPlace, encryptJSON, decryptJSON, isEncrypted } from '../services/crypto'
import type { RecordingEntry, RecordingSource, RecordingState, MeetingMetadata } from '../../shared/types'

async function readMetadata(meetingDir: string): Promise<MeetingMetadata | null> {
  const metaPath = join(meetingDir, 'metadata.json')
  try {
    if (await isEncrypted(metaPath)) {
      return await decryptJSON<MeetingMetadata>(metaPath)
    }
    return JSON.parse(await readFile(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

export function registerRecordingIpc(
  recordingService: RecordingService,
  transcriptionService: TranscriptionService,
): void {
  ipcMain.handle('recording:list', async (): Promise<RecordingEntry[]> => {
    const baseDir = recordingService.getRecordingsBaseDir()
    let dirs: string[]
    try {
      dirs = await readdir(baseDir)
    } catch {
      return []
    }

    const entries: RecordingEntry[] = []
    for (const meetingId of dirs) {
      const meetingDir = join(baseDir, meetingId)
      const dirStat = await stat(meetingDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const audioPath = join(meetingDir, 'audio.webm')
      const videoPath = join(meetingDir, 'screen.webm')
      const audioStat = await stat(audioPath).catch(() => null)
      const videoStat = await stat(videoPath).catch(() => null)

      if (!audioStat && !videoStat) continue

      const metadata = await readMetadata(meetingDir)
      const createdAt = metadata
        ? new Date(metadata.startedAt)
        : dirStat.birthtime

      const title = metadata?.sourceName
        ? `${metadata.sourceName} — ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : `Recording ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

      const transcriptionStatus = await transcriptionService.getStatus(meetingId)

      entries.push({
        meetingId,
        title,
        date: createdAt.getTime(),
        duration: metadata?.durationSeconds ?? null,
        hasVideo: videoStat !== null,
        hasAudio: audioStat !== null,
        transcriptionStatus,
      })
    }

    return entries.sort((a, b) => b.date - a.date)
  })

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

    const stoppedAt = Date.now()
    const metadata: MeetingMetadata = {
      sourceName: result.sourceName,
      startedAt: result.startedAt,
      stoppedAt,
      durationSeconds: Math.round((stoppedAt - result.startedAt) / 1000),
    }

    // Fire-and-forget: save metadata, encrypt, then enqueue transcription
    ;(async () => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, result.meetingId)
      await encryptJSON(metadata, join(meetingDir, 'metadata.json'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const audioPath = join(meetingDir, 'audio.webm')
      const videoPath = join(meetingDir, 'screen.webm')
      try { await encryptFileInPlace(audioPath) } catch (err) { console.error('Failed to encrypt audio:', err) }
      try { await encryptFileInPlace(videoPath) } catch (err) { console.error('Failed to encrypt video:', err) }
      transcriptionService.enqueue(result.meetingId)
    })()

    return result
  })

  ipcMain.handle('recording:get-state', () => {
    return recordingService.getState()
  })

  ipcMain.handle('recording:get-detail', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const metadata = await readMetadata(meetingDir)
    const dirStat = await stat(meetingDir).catch(() => null)
    const startedAt = metadata?.startedAt ?? dirStat?.birthtime.getTime() ?? Date.now()
    const createdAt = new Date(startedAt)

    return {
      title: metadata?.sourceName
        ? `${metadata.sourceName} — ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : `Recording ${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      sourceName: metadata?.sourceName ?? null,
      date: startedAt,
      durationSeconds: metadata?.durationSeconds ?? null,
    }
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
