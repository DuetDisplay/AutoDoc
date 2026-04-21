// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import { RecordingService } from '../services/recording'
import { TranscriptionService } from '../services/transcription'
import type { WhisperManager } from '../services/whisper-manager'
import type { CalendarManager } from '../services/calendar-manager'
import { encryptJSON } from '../services/crypto'
import { matchCalendarEvent, readMetadata } from '../services/calendar-matcher'
import { logAutodocFailure } from '../services/autodoc-log'
import { refreshTray } from '../services/tray'
import { getE2ERecordingSources } from '../services/e2e-fixtures'
import type {
  CalendarEvent,
  RecordingEntry,
  RecordingSource,
  RecordingState,
  MeetingMetadata,
  RecordingTrackingContext
} from '../../shared/types'

const SEGMENT_PAD_WIDTH = 4
const isE2E = process.env.AUTODOC_E2E === '1'

function getSegmentBaseName(type: 'video' | 'mic' | 'system'): string {
  return type === 'video' ? 'screen' : type
}

function getFinalFilename(type: 'video' | 'mic' | 'system'): string {
  return `${getSegmentBaseName(type)}.webm`
}

function getSegmentFilename(type: 'video' | 'mic' | 'system', segmentIndex: number): string {
  return `${getSegmentBaseName(type)}-${String(segmentIndex).padStart(SEGMENT_PAD_WIDTH, '0')}.webm`
}

/** Merge two audio files into one using amix filter */
function mergeAudioFiles(
  ffmpegPath: string,
  input1: string,
  input2: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i',
      input1,
      '-i',
      input2,
      '-filter_complex',
      'amix=inputs=2:duration=longest',
      '-y',
      outputPath
    ])
    let stderr = ''
    proc.on('error', (err) => reject(new Error(`ffmpeg merge spawn failed: ${err.message}`)))
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg merge exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

function concatWebmFiles(ffmpegPath: string, listPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-y',
      outputPath
    ])
    let stderr = ''
    proc.on('error', (err) => reject(new Error(`ffmpeg concat spawn failed: ${err.message}`)))
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg concat exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

async function assembleSegmentedCaptureFile(
  meetingDir: string,
  type: 'video' | 'mic' | 'system',
  ffmpegPath: string | null
): Promise<void> {
  const finalFilename = getFinalFilename(type)
  const finalPath = join(meetingDir, finalFilename)
  const segmentPrefix = `${getSegmentBaseName(type)}-`
  const segmentNames = (await readdir(meetingDir))
    .filter((name) => name.startsWith(segmentPrefix) && name.endsWith('.webm'))
    .sort((a, b) => a.localeCompare(b))

  if (segmentNames.length === 0) {
    return
  }

  await unlink(finalPath).catch(() => {})

  if (segmentNames.length === 1) {
    await rename(join(meetingDir, segmentNames[0]), finalPath)
    return
  }

  if (!ffmpegPath) {
    throw new Error(`Cannot assemble ${finalFilename} without ffmpeg`)
  }

  const listPath = join(meetingDir, `${segmentPrefix}concat.txt`)
  const segmentPaths = segmentNames.map((name) => join(meetingDir, name))
  const listFile = `${segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join('\n')}\n`

  await writeFile(listPath, listFile, 'utf-8')

  try {
    await concatWebmFiles(ffmpegPath, listPath, finalPath)
    await Promise.all(segmentPaths.map((segmentPath) => unlink(segmentPath).catch(() => {})))
  } finally {
    await unlink(listPath).catch(() => {})
  }
}

async function assembleRecordingSegments(
  meetingDir: string,
  ffmpegPath: string | null
): Promise<void> {
  await assembleSegmentedCaptureFile(meetingDir, 'video', ffmpegPath)
  await assembleSegmentedCaptureFile(meetingDir, 'mic', ffmpegPath)
  await assembleSegmentedCaptureFile(meetingDir, 'system', ffmpegPath)
}

/** Mux audio track into video file so playback has both video and audio.
 *  Screen chunks already embed system audio; we must map video from input 0 and
 *  replacement audio from input 1 — otherwise ffmpeg keeps 0:a (system-only) and
 *  the merged mic+system track is ignored, so HTML5 playback only hears system audio. */
function muxAudioIntoVideo(
  ffmpegPath: string,
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-y',
      outputPath
    ])
    let stderr = ''
    proc.on('error', (err) => reject(new Error(`ffmpeg mux spawn failed: ${err.message}`)))
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg mux exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

/** Remux a WebM file to add cue points (seek index) for proper seeking.
 *  MediaRecorder streams WebM without Cues; ffmpeg file output writes them. */
function remuxForSeeking(ffmpegPath: string, inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i',
      inputPath,
      '-c',
      'copy',
      '-fflags',
      '+genpts',
      '-y',
      outputPath
    ])
    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg remux exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

export function registerRecordingIpc(
  recordingService: RecordingService,
  transcriptionService: TranscriptionService,
  whisperManager: WhisperManager,
  calendarManager: CalendarManager
): { stopActiveRecording: () => ReturnType<RecordingService['stopRecording']> } {
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
      if (calendarManager.isConnected()) {
        recentEvents = await calendarManager.fetchAllRecentEvents(30)
      }
    } catch {
      // Calendar fetch failed — fall back to generic names
    }

    const entries: RecordingEntry[] = []
    for (const meetingId of dirs) {
      const meetingDir = join(baseDir, meetingId)
      const dirStat = await stat(meetingDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      const micPath = join(meetingDir, 'mic.webm')
      const legacyAudioPath = join(meetingDir, 'audio.webm')
      const videoPath = join(meetingDir, 'screen.webm')
      const micStat = await stat(micPath).catch(() => null)
      const systemPath = join(meetingDir, 'system.webm')
      const legacyAudioStat = await stat(legacyAudioPath).catch(() => null)
      const systemStat = await stat(systemPath).catch(() => null)
      const videoStat = await stat(videoPath).catch(() => null)

      const hasAudio = micStat !== null || systemStat !== null || legacyAudioStat !== null
      if (!hasAudio && !videoStat) continue

      const metadata = await readMetadata(meetingDir)
      const createdAt = metadata ? new Date(metadata.startedAt) : dirStat.birthtime

      const calendarEvent = matchCalendarEvent(recentEvents, createdAt.getTime())
      const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

      const title = metadata?.customTitle
        ? metadata.customTitle
        : calendarEvent
          ? `${calendarEvent.title} — ${dateSuffix}`
          : metadata?.sourceName
            ? `${metadata.sourceName} — ${dateSuffix}`
            : `Recording ${dateSuffix}`

      const transcriptionStatus = await transcriptionService.getStatus(meetingId)

      // Fallback duration: estimate from directory birthtime to last file mtime
      let duration = metadata?.durationSeconds ?? null
      if (duration == null) {
        const primaryAudioStat = micStat ?? systemStat ?? legacyAudioStat
        const lastMtime = Math.max(primaryAudioStat?.mtimeMs ?? 0, videoStat?.mtimeMs ?? 0)
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
        hasAudio,
        transcriptionStatus
      })
    }

    return entries.sort((a, b) => b.date - a.date)
  })

  ipcMain.handle('recording:get-sources', async (): Promise<RecordingSource[]> => {
    if (isE2E) {
      return getE2ERecordingSources()
    }

    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 }
    })

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL()
    }))
  })

  function stopActiveRecording(): ReturnType<RecordingService['stopRecording']> {
    let result: ReturnType<RecordingService['stopRecording']>
    try {
      result = recordingService.stopRecording()
    } catch (err) {
      logAutodocFailure({
        area: 'recording',
        message: 'Failed to stop recording',
        error: err
      })
      throw err
    }
    broadcastState(recordingService.getState())
    refreshTray()

    const stoppedAt = Date.now()
    const metadata: MeetingMetadata = {
      sourceName: result.sourceName,
      startedAt: result.startedAt,
      stoppedAt,
      durationSeconds: Math.round((stoppedAt - result.startedAt) / 1000)
    }

    // Fire-and-forget: mux audio into video, save metadata, then enqueue transcription
    ;(async () => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, result.meetingId)
      try {
        await encryptJSON(metadata, join(meetingDir, 'metadata.json'))
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to save recording metadata',
          error: err,
          meetingId: result.meetingId
        })
        console.error('Failed to save metadata (continuing with transcription):', err)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const micPath = join(meetingDir, 'mic.webm')
      const systemPath = join(meetingDir, 'system.webm')
      const videoPath = join(meetingDir, 'screen.webm')
      let ffmpegPath: string | null = null

      // Ensure ffmpeg is available before attempting mux
      try {
        await whisperManager.ensureReady()
        ffmpegPath = whisperManager.getFfmpegPath()
      } catch (err) {
        const existingFfmpeg = await stat(whisperManager.getFfmpegPath())
          .then(() => whisperManager.getFfmpegPath())
          .catch(() => null)
        ffmpegPath = existingFfmpeg
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to ensure whisper tools are ready during recording post-processing',
          error: err,
          meetingId: result.meetingId,
          context: { ffmpegPathAvailable: Boolean(existingFfmpeg) }
        })
        console.error('whisperManager.ensureReady() failed — skipping mux:', err)
      }

      try {
        await assembleRecordingSegments(meetingDir, ffmpegPath)
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to assemble segmented recording media',
          error: err,
          meetingId: result.meetingId
        })
        console.error('Failed to assemble segmented recording media:', err)
      }

      // Mux audio into video so the video player has both tracks, then remux for seeking
      try {
        const micStat = await stat(micPath).catch(() => null)
        const systemStat = await stat(systemPath).catch(() => null)
        const videoStat = await stat(videoPath).catch(() => null)
        if (videoStat && (micStat || systemStat)) {
          const muxedPath = join(meetingDir, 'screen-muxed.webm')
          const audioInputs: string[] = []
          if (micStat) audioInputs.push(micPath)
          if (systemStat) audioInputs.push(systemPath)
          if (audioInputs.length === 2) {
            const mergedAudioPath = join(meetingDir, 'merged-audio-tmp.webm')
            if (!ffmpegPath) {
              throw new Error('ffmpeg path unavailable for merged audio mux')
            }
            await mergeAudioFiles(ffmpegPath, micPath, systemPath, mergedAudioPath)
            await muxAudioIntoVideo(ffmpegPath, videoPath, mergedAudioPath, muxedPath)
            await unlink(mergedAudioPath)
          } else {
            if (!ffmpegPath) {
              throw new Error('ffmpeg path unavailable for audio mux')
            }
            await muxAudioIntoVideo(ffmpegPath, videoPath, audioInputs[0], muxedPath)
          }
          await unlink(videoPath)
          await rename(muxedPath, videoPath)
        }
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to mux audio into recorded video',
          error: err,
          meetingId: result.meetingId
        })
        console.error('Failed to mux audio into video:', err)
      }

      // Remux video to add cue points for seeking
      try {
        const videoExists = await stat(videoPath).catch(() => null)
        if (videoExists) {
          if (!ffmpegPath) {
            throw new Error('ffmpeg path unavailable for remux')
          }
          const seekablePath = join(meetingDir, 'screen-seekable.webm')
          await remuxForSeeking(ffmpegPath, videoPath, seekablePath)
          await unlink(videoPath)
          await rename(seekablePath, videoPath)
          const finalStat = await stat(videoPath).catch(() => null)
          console.log('[recording post-process] remux for seeking OK', {
            meetingId: result.meetingId,
            bytes: finalStat?.size,
            path: videoPath
          })
        }
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to remux recorded video for seeking',
          error: err,
          meetingId: result.meetingId
        })
        console.error('Failed to remux for seeking (video will still play but may not seek):', err)
      }

      transcriptionService.enqueue(result.meetingId)
    })().catch((err) => {
      logAutodocFailure({
        area: 'recording',
        message: 'Recording post-processing failed',
        error: err,
        meetingId: result.meetingId
      })
      console.error('Recording post-processing failed:', err)
    })

    return result
  }

  ipcMain.handle(
    'recording:start',
    async (
      _event,
      sourceId: string,
      sourceName: string,
      trackingContext?: RecordingTrackingContext | null
    ) => {
      try {
        const paths = await recordingService.startRecording(
          sourceId,
          sourceName,
          trackingContext ?? null
        )
        broadcastState(recordingService.getState())
        refreshTray()
        return paths
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to start recording',
          error: err,
          context: { sourceId, sourceName, trackingContext: trackingContext ?? null }
        })
        throw err
      }
    }
  )

  ipcMain.handle('recording:stop', () => stopActiveRecording())

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
      if (calendarManager.isConnected()) {
        const events = await calendarManager.fetchAllRecentEvents(30)
        calendarEvent = matchCalendarEvent(events, startedAt)
      }
    } catch {
      // Calendar fetch failed
    }

    const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

    const title = metadata?.customTitle
      ? metadata.customTitle
      : calendarEvent
        ? `${calendarEvent.title} — ${dateSuffix}`
        : metadata?.sourceName
          ? `${metadata.sourceName} — ${dateSuffix}`
          : `Recording ${dateSuffix}`

    return {
      title,
      sourceName: calendarEvent?.title ?? metadata?.sourceName ?? null,
      date: startedAt,
      durationSeconds
    }
  })

  ipcMain.handle(
    'recording:save-chunk',
    async (
      _event,
      meetingId: string,
      type: 'video' | 'mic' | 'system',
      chunk: ArrayBuffer,
      segmentIndex = 0
    ) => {
      const currentState = recordingService.getState()
      if (!currentState.isRecording || currentState.meetingId !== meetingId) {
        return // Ignore chunks for stale or mismatched recordings
      }
      const baseDir = recordingService.getRecordingsBaseDir()
      const filename = getSegmentFilename(type, segmentIndex)
      const filePath = join(baseDir, meetingId, filename)
      try {
        await appendFile(filePath, Buffer.from(chunk))
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to write recording chunk',
          error: err,
          meetingId,
          context: { type, filePath }
        })
        throw err
      }
    }
  )

  ipcMain.handle(
    'recording:update-title',
    async (_event, meetingId: string, customTitle: string) => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, meetingId)
      const metadata = await readMetadata(meetingDir)
      const updated: MeetingMetadata = {
        sourceName: metadata?.sourceName ?? null,
        startedAt: metadata?.startedAt ?? Date.now(),
        stoppedAt: metadata?.stoppedAt ?? Date.now(),
        durationSeconds: metadata?.durationSeconds ?? 0,
        customTitle: customTitle.trim() || undefined
      }
      await encryptJSON(updated, join(meetingDir, 'metadata.json'))
    }
  )

  ipcMain.handle('recording:delete', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) return
    await rm(meetingDir, { recursive: true, force: true })
  })

  return { stopActiveRecording }
}

function broadcastState(state: RecordingState): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('recording:status-changed', state)
  }
}
