// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import { RecordingService } from '../services/recording'
import { TranscriptionService } from '../services/transcription'
import type { WhisperManager } from '../services/whisper-manager'
import type { CalendarService } from '../services/calendar'
import { encryptFileInPlace, encryptJSON, decryptJSON, isEncrypted } from '../services/crypto'
import type { CalendarEvent, RecordingEntry, RecordingSource, RecordingState, MeetingMetadata } from '../../shared/types'

/** Mux audio track into video file so playback has both video and audio */
function muxAudioIntoVideo(ffmpegPath: string, videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-y',
      outputPath,
    ])
    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg mux exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

/** Find calendar event that overlaps with the recording start time (±10min buffer) */
function matchCalendarEvent(events: CalendarEvent[], recordingStartMs: number): CalendarEvent | null {
  const buffer = 10 * 60 * 1000 // 10 minutes
  let best: CalendarEvent | null = null
  let bestOverlap = 0
  for (const event of events) {
    const overlapStart = Math.max(event.startTime - buffer, recordingStartMs)
    const overlapEnd = Math.min(event.endTime + buffer, recordingStartMs + 1)
    if (overlapStart <= overlapEnd) {
      // Prefer the event whose start is closest to the recording start
      const closeness = Math.abs(event.startTime - recordingStartMs)
      if (!best || closeness < bestOverlap) {
        best = event
        bestOverlap = closeness
      }
    }
  }
  return best
}

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
  whisperManager: WhisperManager,
  calendarService: CalendarService,
): void {
  ipcMain.handle('recording:list', async (): Promise<RecordingEntry[]> => {
    const baseDir = recordingService.getRecordingsBaseDir()
    let dirs: string[]
    try {
      dirs = await readdir(baseDir)
    } catch {
      return []
    }

    // Fetch recent calendar events for matching recordings to event names
    let recentEvents: CalendarEvent[] = []
    try {
      if (calendarService.isConnected()) {
        recentEvents = await calendarService.fetchRecentEvents(30)
      }
    } catch {
      // Calendar fetch failed — fall back to generic names
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

      const calendarEvent = matchCalendarEvent(recentEvents, createdAt.getTime())
      const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

      const title = calendarEvent
        ? `${calendarEvent.title} — ${dateSuffix}`
        : metadata?.sourceName
          ? `${metadata.sourceName} — ${dateSuffix}`
          : `Recording ${dateSuffix}`

      const transcriptionStatus = await transcriptionService.getStatus(meetingId)

      // Fallback duration: estimate from directory birthtime to last file mtime
      let duration = metadata?.durationSeconds ?? null
      if (duration == null) {
        const lastMtime = Math.max(audioStat?.mtimeMs ?? 0, videoStat?.mtimeMs ?? 0)
        if (lastMtime > 0) {
          const estimated = Math.round((lastMtime - dirStat.birthtime.getTime()) / 1000)
          if (estimated > 0) duration = estimated
        }
      }

      entries.push({
        meetingId,
        title,
        date: createdAt.getTime(),
        duration,
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

    // Fire-and-forget: mux audio into video, save metadata, encrypt, then enqueue transcription
    ;(async () => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, result.meetingId)
      await encryptJSON(metadata, join(meetingDir, 'metadata.json'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const audioPath = join(meetingDir, 'audio.webm')
      const videoPath = join(meetingDir, 'screen.webm')

      // Mux audio into video so the video player has both tracks
      try {
        const audioStat = await stat(audioPath).catch(() => null)
        const videoStat = await stat(videoPath).catch(() => null)
        if (audioStat && videoStat) {
          const muxedPath = join(meetingDir, 'screen-muxed.webm')
          await muxAudioIntoVideo(whisperManager.getFfmpegPath(), videoPath, audioPath, muxedPath)
          await unlink(videoPath)
          await rename(muxedPath, videoPath)
        }
      } catch (err) {
        console.error('Failed to mux audio into video:', err)
      }

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

    // Fallback duration from directory timestamps
    let durationSeconds = metadata?.durationSeconds ?? null
    if (durationSeconds == null && dirStat) {
      const estimated = Math.round((dirStat.mtimeMs - dirStat.birthtime.getTime()) / 1000)
      if (estimated > 0) durationSeconds = estimated
    }

    // Try to match a calendar event for a better title
    let calendarEvent: CalendarEvent | null = null
    try {
      if (calendarService.isConnected()) {
        const events = await calendarService.fetchRecentEvents(30)
        calendarEvent = matchCalendarEvent(events, startedAt)
      }
    } catch {
      // Calendar fetch failed
    }

    const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

    const title = calendarEvent
      ? `${calendarEvent.title} — ${dateSuffix}`
      : metadata?.sourceName
        ? `${metadata.sourceName} — ${dateSuffix}`
        : `Recording ${dateSuffix}`

    return {
      title,
      sourceName: calendarEvent?.title ?? metadata?.sourceName ?? null,
      date: startedAt,
      durationSeconds,
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
