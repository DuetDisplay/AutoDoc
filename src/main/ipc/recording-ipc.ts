// src/main/ipc/recording-ipc.ts
import { ipcMain, desktopCapturer, BrowserWindow } from 'electron'
import { appendFile, readdir, rm, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { spawn } from 'child_process'
import { RecordingService } from '../services/recording'
import { TranscriptionService } from '../services/transcription'
import type { WhisperManager } from '../services/whisper-manager'
import type { CalendarManager } from '../services/calendar-manager'
import { encryptJSON } from '../services/crypto'
import { matchCalendarEvent, readMetadata } from '../services/calendar-matcher'
import { logAutodocEvent, logAutodocFailure } from '../services/autodoc-log'
import { getStorageDiagnostics } from '../services/storage-manager'
import { refreshTray } from '../services/tray'
import { getE2ERecordingSources } from '../services/e2e-fixtures'
import { renameWithRetry, replaceFileWithRetry } from '../services/file-operation-retry'
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
const isWindows = process.platform === 'win32'
const CALENDAR_MATCH_LOOKBACK_DAYS = 30
const WINDOWS_CALENDAR_CACHE_TTL_MS = 30_000
const RECORDING_DEBUG_PREFIX = '[recording-debug]'

function getSegmentBaseName(type: 'video' | 'mic' | 'system'): string {
  return type === 'video' ? 'screen' : type
}

function getFinalFilename(type: 'video' | 'mic' | 'system'): string {
  return `${getSegmentBaseName(type)}.webm`
}

function getSegmentFilename(type: 'video' | 'mic' | 'system', segmentIndex: number): string {
  return `${getSegmentBaseName(type)}-${String(segmentIndex).padStart(SEGMENT_PAD_WIDTH, '0')}.webm`
}

function buildRecordingTitle(
  metadata: MeetingMetadata | null,
  startedAt: number,
  calendarTitle: string | null
): string {
  const createdAt = new Date(startedAt)
  const dateSuffix = `${createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`

  if (metadata?.customTitle) {
    return metadata.customTitle
  }

  if (calendarTitle) {
    return `${calendarTitle} — ${dateSuffix}`
  }

  if (metadata?.sourceName) {
    return `${metadata.sourceName} — ${dateSuffix}`
  }

  return `Recording ${dateSuffix}`
}

function logRecordingDebug(
  message: string,
  meetingId?: string,
  context?: Record<string, unknown>
): void {
  logAutodocEvent({
    area: 'recording',
    message,
    meetingId,
    context
  })
  console.log(RECORDING_DEBUG_PREFIX, message, {
    meetingId: meetingId ?? null,
    ...(context ?? {})
  })
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

function concatVideoSegments(
  ffmpegPath: string,
  listPath: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-fflags',
      '+genpts',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-map',
      '0:v:0',
      '-an',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'good',
      '-cpu-used',
      '6',
      '-row-mt',
      '1',
      '-crf',
      '36',
      '-b:v',
      '0',
      '-y',
      outputPath
    ])
    let stderr = ''
    proc.on('error', (err) =>
      reject(new Error(`ffmpeg video concat spawn failed: ${err.message}`))
    )
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg video concat exited with code ${code}: ${stderr.slice(-500)}`))
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
    await renameWithRetry(join(meetingDir, segmentNames[0]), finalPath)
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
    if (type === 'video') {
      await concatVideoSegments(ffmpegPath, listPath, finalPath)
    } else {
      await concatWebmFiles(ffmpegPath, listPath, finalPath)
    }
    await Promise.all(segmentPaths.map((segmentPath) => unlink(segmentPath).catch(() => {})))
  } finally {
    await unlink(listPath).catch(() => {})
  }
}

function normalizeCaptureSourceError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  const normalized = message.toLowerCase()

  if (
    normalized.includes('denied') ||
    normalized.includes('not permitted') ||
    normalized.includes('permission')
  ) {
    return new Error(
      'AutoDoc could not list capture sources. Screen recording permission may be missing.'
    )
  }

  return err instanceof Error ? err : new Error(message)
}

async function assembleRecordingSegments(
  meetingDir: string,
  ffmpegPath: string | null
): Promise<void> {
  await assembleSegmentedCaptureFile(meetingDir, 'video', ffmpegPath)
  await assembleSegmentedCaptureFile(meetingDir, 'mic', ffmpegPath)
  await assembleSegmentedCaptureFile(meetingDir, 'system', ffmpegPath)
}

async function getSegmentedCapturePresence(
  meetingDir: string
): Promise<{ hasSegmentedAudio: boolean, hasSegmentedVideo: boolean }> {
  const names = await readdir(meetingDir).catch(() => [])
  return {
    hasSegmentedAudio: names.some((name) =>
      (name.startsWith('mic-') || name.startsWith('system-') || name.startsWith('audio-')) &&
      name.endsWith('.webm')
    ),
    hasSegmentedVideo: names.some((name) => name.startsWith('screen-') && name.endsWith('.webm'))
  }
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
  let cachedRecentEvents:
    | {
        fetchedAt: number
        events: CalendarEvent[]
      }
    | null = null
  let recentEventsPromise: Promise<CalendarEvent[]> | null = null
  const windowsPendingFinalization = new Map<string, MeetingMetadata>()
  const windowsCalendarRefreshInFlight = new Set<string>()

  async function persistRecordingMetadata(
    meetingDir: string,
    metadata: MeetingMetadata
  ): Promise<void> {
    await encryptJSON(metadata, join(meetingDir, 'metadata.json'))
  }

  async function getDeletionDiagnostics(meetingId: string): Promise<Record<string, unknown>> {
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const diagnostics = await getStorageDiagnostics({
      meetingDir,
      whisperBinaryPath: whisperManager.getWhisperPath(),
      ffmpegPath: whisperManager.getFfmpegPath(),
      whisperModelPath: whisperManager.getModelPath(),
    })

    return {
      recordingsBaseDir: baseDir,
      ...diagnostics,
    }
  }

  async function clearWindowsFinalizingState(
    meetingId: string,
    metadata: MeetingMetadata,
    reason: 'post-processing-finished' | 'post-processing-failed'
  ): Promise<MeetingMetadata> {
    if (!isWindows || metadata.isFinalizing !== true) {
      return metadata
    }

    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const finalizedMetadata: MeetingMetadata = {
      ...metadata,
      isFinalizing: false
    }

    windowsPendingFinalization.delete(meetingId)

    try {
      await persistRecordingMetadata(meetingDir, finalizedMetadata)
      logRecordingDebug('windows finalizing state cleared', meetingId, {
        reason,
        pendingAfterCount: windowsPendingFinalization.size
      })
    } catch (err) {
      logAutodocFailure({
        area: 'recording',
        message: 'Failed to clear Windows recording finalizing state',
        error: err,
        meetingId,
        context: { reason }
      })
    }

    return finalizedMetadata
  }

  function runRecordingPostProcessing(meetingId: string, metadata: MeetingMetadata): void {
    void (async () => {
      const postProcessStartedAt = Date.now()
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, meetingId)
      logRecordingDebug('post-processing started', meetingId, {
        startedAt: metadata.startedAt,
        stoppedAt: metadata.stoppedAt,
        isFinalizing: metadata.isFinalizing ?? false
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const micPath = join(meetingDir, 'mic.webm')
      const systemPath = join(meetingDir, 'system.webm')
      const videoPath = join(meetingDir, 'screen.webm')
      let ffmpegPath: string | null = null

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
          meetingId,
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
          meetingId
        })
        console.error('Failed to assemble segmented recording media:', err)
      }

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
          await replaceFileWithRetry(muxedPath, videoPath)
        }
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to mux audio into recorded video',
          error: err,
          meetingId
        })
        console.error('Failed to mux audio into video:', err)
      }

      try {
        const videoExists = await stat(videoPath).catch(() => null)
        if (videoExists) {
          if (!ffmpegPath) {
            throw new Error('ffmpeg path unavailable for remux')
          }
          const seekablePath = join(meetingDir, 'screen-seekable.webm')
          await remuxForSeeking(ffmpegPath, videoPath, seekablePath)
          await replaceFileWithRetry(seekablePath, videoPath)
          const finalStat = await stat(videoPath).catch(() => null)
          console.log('[recording post-process] remux for seeking OK', {
            meetingId,
            bytes: finalStat?.size,
            path: videoPath
          })
        }
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to remux recorded video for seeking',
          error: err,
          meetingId
        })
        console.error('Failed to remux for seeking (video will still play but may not seek):', err)
      }

      const finalizedMetadata = await clearWindowsFinalizingState(
        meetingId,
        metadata,
        'post-processing-finished'
      )
      transcriptionService.enqueue(meetingId)
      scheduleWindowsCalendarTitleRefresh(meetingId, meetingDir, finalizedMetadata)
      broadcastEntryUpdated(meetingId)
      logRecordingDebug('post-processing finished', meetingId, {
        elapsedMs: Date.now() - postProcessStartedAt,
        isFinalizing: finalizedMetadata.isFinalizing ?? false
      })
    })().catch((err) => {
      void (async () => {
        logAutodocFailure({
          area: 'recording',
          message: 'Recording post-processing failed',
          error: err,
          meetingId
        })

        const finalizedMetadata = await clearWindowsFinalizingState(
          meetingId,
          metadata,
          'post-processing-failed'
        )
        scheduleWindowsCalendarTitleRefresh(
          meetingId,
          join(recordingService.getRecordingsBaseDir(), meetingId),
          finalizedMetadata
        )
        broadcastEntryUpdated(meetingId)
        console.error('Recording post-processing failed:', err)
      })().catch((cleanupErr) => {
        console.error('Recording post-processing cleanup failed:', cleanupErr)
      })
    })
  }

  function broadcastEntryUpdated(meetingId: string): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('recording:entry-updated', { meetingId })
    }
  }

  async function getRecentEventsForMatching(): Promise<CalendarEvent[]> {
    if (!calendarManager.isConnected()) {
      return []
    }

    if (
      cachedRecentEvents &&
      Date.now() - cachedRecentEvents.fetchedAt < WINDOWS_CALENDAR_CACHE_TTL_MS
    ) {
      return cachedRecentEvents.events
    }

    if (recentEventsPromise) {
      return recentEventsPromise
    }

    recentEventsPromise = calendarManager
      .fetchAllRecentEvents(CALENDAR_MATCH_LOOKBACK_DAYS)
      .then((events) => {
        logRecordingDebug('calendar events fetched for title matching', undefined, {
          count: events.length,
          elapsedMs:
            cachedRecentEvents == null ? undefined : Date.now() - cachedRecentEvents.fetchedAt
        })
        cachedRecentEvents = {
          fetchedAt: Date.now(),
          events
        }
        return events
      })
      .finally(() => {
        recentEventsPromise = null
      })

    return recentEventsPromise
  }

  function scheduleWindowsCalendarTitleRefresh(
    meetingId: string,
    meetingDir: string,
    metadataHint: MeetingMetadata | null = null
  ): void {
    // Windows users were waiting on a live calendar fetch before a freshly stopped
    // recording appeared in AI Notes. We keep macOS behavior as-is and do the
    // calendar match lazily on Windows so the item shows up immediately and stays clickable.
    if (!isWindows || !calendarManager.isConnected() || windowsCalendarRefreshInFlight.has(meetingId)) {
      return
    }

    windowsCalendarRefreshInFlight.add(meetingId)
    logRecordingDebug('scheduled background calendar title refresh', meetingId, {
      hasMetadataHint: metadataHint != null
    })

    void (async () => {
      const refreshStartedAt = Date.now()
      try {
        const metadata = metadataHint ?? (await readMetadata(meetingDir))
        if (!metadata?.startedAt || metadata.customTitle || metadata.calendarTitle) {
          return
        }

        const events = await getRecentEventsForMatching()
        const matched = matchCalendarEvent(events, metadata.startedAt)
        const calendarTitle = matched?.title?.trim() || null
        if (!calendarTitle) {
          return
        }

        const latestMetadata = (await readMetadata(meetingDir)) ?? metadata
        if (latestMetadata.customTitle || latestMetadata.calendarTitle === calendarTitle) {
          return
        }

        await encryptJSON(
          {
            ...latestMetadata,
            calendarTitle
          },
          join(meetingDir, 'metadata.json')
        )
        broadcastEntryUpdated(meetingId)
        logRecordingDebug('background calendar title refresh finished', meetingId, {
          calendarTitle,
          elapsedMs: Date.now() - refreshStartedAt
        })
      } catch (err) {
        logAutodocFailure({
          area: 'recording',
          message: 'Failed to resolve recording calendar title in background',
          error: err,
          meetingId
        })
      } finally {
        windowsCalendarRefreshInFlight.delete(meetingId)
      }
    })()
  }

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
      if (calendarManager.isConnected() && !isWindows) {
        recentEvents = await calendarManager.fetchAllRecentEvents(CALENDAR_MATCH_LOOKBACK_DAYS)
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
      const segmentedPresence = await getSegmentedCapturePresence(meetingDir)

      const pendingMetadata = windowsPendingFinalization.get(meetingId) ?? null
      const hasAudio =
        micStat !== null ||
        systemStat !== null ||
        legacyAudioStat !== null ||
        segmentedPresence.hasSegmentedAudio
      const hasVideo = videoStat !== null || segmentedPresence.hasSegmentedVideo
      const metadata = (await readMetadata(meetingDir)) ?? pendingMetadata
      const isFinalizing = metadata?.isFinalizing === true
      if (!hasAudio && !hasVideo && !isFinalizing) continue
      const startedAt = metadata?.startedAt ?? dirStat.birthtime.getTime()

      const calendarTitle =
        matchCalendarEvent(recentEvents, startedAt)?.title ?? metadata?.calendarTitle ?? null
      const title = buildRecordingTitle(metadata, startedAt, calendarTitle)

      if (!metadata?.customTitle && !calendarTitle) {
        scheduleWindowsCalendarTitleRefresh(meetingId, meetingDir, metadata)
      }
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
        date: startedAt,
        duration,
        hasVideo,
        hasAudio,
        isFinalizing,
        transcriptionStatus
      })
    }

    if (isWindows) {
      logRecordingDebug('recording:list resolved', undefined, {
        entryCount: entries.length,
        finalizingMeetingIds: entries.filter((entry) => entry.isFinalizing).map((entry) => entry.meetingId)
      })
    }

    return entries.sort((a, b) => b.date - a.date)
  })

  ipcMain.handle('recording:get-sources', async (): Promise<RecordingSource[]> => {
    if (isE2E) {
      return getE2ERecordingSources()
    }

    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 }
      })
    } catch (err) {
      throw normalizeCaptureSourceError(err)
    }

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL()
    }))
  })

  function stopActiveRecording(): ReturnType<RecordingService['stopRecording']> {
    const stopRequestedAt = Date.now()
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
      durationSeconds: Math.round((stoppedAt - result.startedAt) / 1000),
      isFinalizing: isWindows
    }
    logRecordingDebug('recording:stop completed in main process', result.meetingId, {
      elapsedMs: Date.now() - stopRequestedAt,
      isWindows,
      metadataDurationSeconds: metadata.durationSeconds
    })

    if (isWindows) {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, result.meetingId)
      windowsPendingFinalization.set(result.meetingId, metadata)
      logRecordingDebug('windows finalizing entry created', result.meetingId, {
        pendingFinalizationCount: windowsPendingFinalization.size
      })
      void persistRecordingMetadata(meetingDir, metadata)
        .then(() => {
          logRecordingDebug('windows finalizing metadata persisted', result.meetingId, {
            elapsedMs: Date.now() - stopRequestedAt
          })
          scheduleWindowsCalendarTitleRefresh(result.meetingId, meetingDir, metadata)
          broadcastEntryUpdated(result.meetingId)
        })
        .catch((err) => {
          logAutodocFailure({
            area: 'recording',
            message: 'Failed to save recording metadata during Windows stop finalization',
            error: err,
            meetingId: result.meetingId
          })
        })
      broadcastEntryUpdated(result.meetingId)
      return result
    }

    // Fire-and-forget: mux audio into video, save metadata, then enqueue transcription
    ;(async () => {
      const baseDir = recordingService.getRecordingsBaseDir()
      const meetingDir = join(baseDir, result.meetingId)
      try {
        await encryptJSON(metadata, join(meetingDir, 'metadata.json'))
        scheduleWindowsCalendarTitleRefresh(result.meetingId, meetingDir, metadata)
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
          await replaceFileWithRetry(muxedPath, videoPath)
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
          await replaceFileWithRetry(seekablePath, videoPath)
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

  ipcMain.handle('recording:finalize-stop', async (_event, meetingId: string) => {
    if (!isWindows) {
      return
    }

    const finalizeStartedAt = Date.now()
    logRecordingDebug('recording:finalize-stop received', meetingId, {
      pendingBefore: windowsPendingFinalization.has(meetingId)
    })
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const pendingMetadataFromMap = windowsPendingFinalization.get(meetingId) ?? null
    const metadata = (await readMetadata(meetingDir)) ?? pendingMetadataFromMap
    if (!metadata) {
      windowsPendingFinalization.delete(meetingId)
      return
    }

    // Windows can take noticeably longer than macOS to assemble chunked WebM output
    // after the renderer has already flushed its final recorder data. Keep the entry in
    // a temporary finalizing state until post-processing finishes so it stays visible.
    const finalizingMetadata: MeetingMetadata = {
      ...metadata,
      isFinalizing: true
    }

    windowsPendingFinalization.set(meetingId, finalizingMetadata)
    await persistRecordingMetadata(meetingDir, finalizingMetadata)
    broadcastEntryUpdated(meetingId)
    logRecordingDebug('recording:finalize-stop keeping finalizing state until post-processing completes', meetingId, {
      elapsedMs: Date.now() - finalizeStartedAt,
      pendingAfterCount: windowsPendingFinalization.size
    })
    runRecordingPostProcessing(meetingId, finalizingMetadata)
  })

  ipcMain.handle('recording:get-state', () => {
    return recordingService.getState()
  })

  ipcMain.handle('recording:get-detail', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const pendingMetadata = windowsPendingFinalization.get(meetingId) ?? null
    const metadata = (await readMetadata(meetingDir)) ?? pendingMetadata
    const dirStat = await stat(meetingDir).catch(() => null)
    const startedAt = metadata?.startedAt ?? dirStat?.birthtime.getTime() ?? Date.now()
    const isFinalizing = metadata?.isFinalizing === true
    // Fallback duration from directory timestamps
    let durationSeconds = metadata?.durationSeconds ?? null
    if (durationSeconds == null && dirStat) {
      const estimated = Math.round((dirStat.mtimeMs - dirStat.birthtime.getTime()) / 1000)
      if (estimated > 0) durationSeconds = estimated
    }

    // Try to match a calendar event for a better title
    let calendarEvent: CalendarEvent | null = null
    try {
      if (calendarManager.isConnected() && !isWindows) {
        const events = await calendarManager.fetchAllRecentEvents(CALENDAR_MATCH_LOOKBACK_DAYS)
        calendarEvent = matchCalendarEvent(events, startedAt)
      }
    } catch {
      // Calendar fetch failed
    }

    const calendarTitle = calendarEvent?.title ?? metadata?.calendarTitle ?? null

    const title = buildRecordingTitle(metadata, startedAt, calendarTitle)
    if (!metadata?.customTitle && !calendarTitle) {
      scheduleWindowsCalendarTitleRefresh(meetingId, meetingDir, metadata)
    }
    if (isWindows && isFinalizing) {
      logRecordingDebug('recording:get-detail returned finalizing entry', meetingId, {
        hasMetadata: metadata != null,
        durationSeconds
      })
    }
    return {
      title,
      sourceName: calendarTitle ?? metadata?.sourceName ?? null,
      date: startedAt,
      durationSeconds,
      isFinalizing
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
      const allowFinalizingWrite = isWindows && windowsPendingFinalization.has(meetingId)
      if ((!currentState.isRecording || currentState.meetingId !== meetingId) && !allowFinalizingWrite) {
        return // Ignore chunks for stale or mismatched recordings
      }
      const baseDir = recordingService.getRecordingsBaseDir()
      const filename = getSegmentFilename(type, segmentIndex)
      const filePath = join(baseDir, meetingId, filename)
      try {
        await appendFile(filePath, Buffer.from(chunk))
        if (allowFinalizingWrite) {
          logRecordingDebug('accepted chunk write during finalization', meetingId, {
            type,
            segmentIndex,
            bytes: chunk.byteLength
          })
        }
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
        isFinalizing: metadata?.isFinalizing,
        calendarTitle: metadata?.calendarTitle,
        customTitle: customTitle.trim() || undefined
      }
      await encryptJSON(updated, join(meetingDir, 'metadata.json'))
      if (windowsPendingFinalization.has(meetingId)) {
        windowsPendingFinalization.set(meetingId, updated)
      }
      broadcastEntryUpdated(meetingId)
    }
  )

  ipcMain.handle('recording:delete', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const meetingDir = join(baseDir, meetingId)
    const dirStat = await stat(meetingDir).catch(() => null)
    if (!dirStat?.isDirectory()) return
    logAutodocEvent({
      area: 'recording',
      message: 'recording:delete requested',
      meetingId,
      context: await getDeletionDiagnostics(meetingId),
    })
    await rm(meetingDir, { recursive: true, force: true })
    logAutodocEvent({
      area: 'recording',
      message: 'recording:delete completed',
      meetingId,
      context: await getDeletionDiagnostics(meetingId),
    })
  })

  return { stopActiveRecording }
}

function broadcastState(state: RecordingState): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('recording:status-changed', state)
  }
}
