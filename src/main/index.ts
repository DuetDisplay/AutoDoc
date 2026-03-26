import { app, BrowserWindow, ipcMain, shell, systemPreferences, desktopCapturer, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { stat, readdir, rename, mkdir, access, rmdir } from 'fs/promises'
import { isEncrypted, decryptFileToTemp, migrateRecordings, cleanupTempFiles } from './services/crypto'
import { is } from '@electron-toolkit/utils'
import { CalendarService } from './services/calendar'
import { registerCalendarIpc } from './ipc/calendar-ipc'
import { RecordingService } from './services/recording'
import { registerRecordingIpc } from './ipc/recording-ipc'
import { WhisperManager } from './services/whisper-manager'
import { AudioConverter } from './services/audio-converter'
import { TranscriptionService } from './services/transcription'
import { DiarizationService } from './services/diarization'
import { registerTranscriptionIpc } from './ipc/transcription-ipc'
import { OllamaProvider } from './services/llm'
import { OllamaManager } from './services/ollama-manager'
import { SegmentationService } from './services/segmentation'
import { registerLlmIpc } from './ipc/llm-ipc'
import { DetectionService } from './services/detection'
import { registerSearchIpc } from './ipc/search-ipc'
import { registerChatIpc } from './ipc/chat-ipc'
import { registerSpeakersIpc } from './ipc/speakers-ipc'
import { PrefsStore } from './services/prefs-store'
import { registerPrefsIpc } from './ipc/prefs-ipc'
import { createTray, updateTrayMenu } from './services/tray'
import type { OllamaSetupStatus } from '../shared/types'

// Ensure consistent app name for safeStorage keychain service across dev and production
app.setName('AutoDoc')

// Set dock icon in dev (production uses the bundled .icns)
if (process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(join(__dirname, '../../build/icon.png'))
}

let ollamaManager: OllamaManager | null = null
let isQuitting = false

protocol.registerSchemesAsPrivileged([
  { scheme: 'autodoc-media', privileges: { stream: true, bypassCSP: true } },
])

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#FAFAF7',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Hide to tray instead of closing (unless user is quitting)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('app:get-version', () => app.getVersion())

  const prefsStore = new PrefsStore()
  registerPrefsIpc(prefsStore)

  ipcMain.handle('permissions:check', async () => {
    if (process.platform === 'darwin') {
      const microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
      // Screen recording: try getting sources — if we get thumbnails with actual content, we have permission
      let screen = false
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        // On macOS, sources are returned but thumbnails are empty when permission is denied
        screen = sources.length > 0 && !sources[0].thumbnail.isEmpty()
      } catch {
        screen = false
      }
      return { screen, microphone }
    }
    // On Windows/Linux, permissions are generally granted by default
    return { screen: true, microphone: true }
  })

  ipcMain.handle('permissions:open-settings', (_event, panel: 'screen' | 'microphone') => {
    if (process.platform === 'darwin') {
      if (panel === 'screen') {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      } else {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }
  })

  const calendarService = new CalendarService()
  registerCalendarIpc(calendarService, (events) => {
    cachedEvents = events
    updateTrayMenu()
  })

  const recordingService = new RecordingService()

  // Serve recording media files via autodoc-media:// protocol
  protocol.handle('autodoc-media', async (request) => {
    const url = new URL(request.url)
    // autodoc-media://{meetingId}/{filename}
    const meetingId = url.hostname
    const filename = url.pathname.slice(1) // remove leading /
    const filePath = join(recordingService.getRecordingsBaseDir(), meetingId, filename)

    if (await isEncrypted(filePath)) {
      const tempPath = await decryptFileToTemp(filePath)
      return net.fetch(pathToFileURL(tempPath).href)
    }

    return net.fetch(pathToFileURL(filePath).href)
  })

  ipcMain.handle('recording:get-media', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const videoPath = join(baseDir, meetingId, 'screen.webm')
    const systemPath = join(baseDir, meetingId, 'system.webm')
    const legacyAudioPath = join(baseDir, meetingId, 'audio.webm')
    const hasVideo = await stat(videoPath).then(() => true).catch(() => false)
    const hasSystemAudio = await stat(systemPath).then(() => true).catch(() => false)
    const hasLegacyAudio = await stat(legacyAudioPath).then(() => true).catch(() => false)
    return { hasVideo, hasAudio: hasSystemAudio || hasLegacyAudio, audioFile: hasSystemAudio ? 'system.webm' : 'audio.webm' }
  })
  const whisperManager = new WhisperManager()
  const audioConverter = new AudioConverter()
  const diarizationService = new DiarizationService()
  const transcriptionService = new TranscriptionService(
    whisperManager,
    audioConverter,
    recordingService.getRecordingsBaseDir(),
    diarizationService,
    calendarService,
  )
  ollamaManager = new OllamaManager()

  // Mutable state tracking Ollama setup progress
  const ollamaSetupState: OllamaSetupStatus = { phase: 'downloading', percent: 0 }

  function broadcastOllamaStatus(): void {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('ollama:setup-progress', { ...ollamaSetupState })
    }
  }

  ollamaManager.on('download-start', () => {
    ollamaSetupState.phase = 'downloading'
    ollamaSetupState.percent = 0
    broadcastOllamaStatus()
  })

  ollamaManager.on('download-progress', (data: { percent: number }) => {
    ollamaSetupState.phase = 'downloading'
    ollamaSetupState.percent = data.percent
    broadcastOllamaStatus()
  })

  ollamaManager.on('download-complete', () => {
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = 0
    broadcastOllamaStatus()
  })

  ollamaManager.on('pull-start', () => {
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = 0
    broadcastOllamaStatus()
  })

  ollamaManager.on('pull-progress', (data: { percent: number }) => {
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = data.percent
    broadcastOllamaStatus()
  })

  ollamaManager.on('pull-complete', () => {
    ollamaSetupState.phase = 'ready'
    ollamaSetupState.percent = 100
    broadcastOllamaStatus()
  })

  const ollamaProvider = new OllamaProvider(ollamaManager.getBaseUrl(), ollamaManager.getModel())
  const segmentationService = new SegmentationService(
    ollamaProvider,
    ollamaManager,
    recordingService.getRecordingsBaseDir(),
  )

  transcriptionService.onComplete((meetingId) => {
    segmentationService.enqueue(meetingId)
  })

  let cachedEvents: import('../../shared/types').CalendarEvent[] = []

  const detectionService = new DetectionService(
    recordingService,
    () => cachedEvents,
  )

  ipcMain.handle('detection:dismiss', () => {
    detectionService.dismissPrompt()
  })

  registerRecordingIpc(recordingService, transcriptionService, whisperManager, calendarService)
  registerTranscriptionIpc(transcriptionService)
  registerLlmIpc(segmentationService, ollamaManager, ollamaProvider, () => ({ ...ollamaSetupState }))
  registerSearchIpc(recordingService.getRecordingsBaseDir())
  registerChatIpc(recordingService.getRecordingsBaseDir(), ollamaManager, ollamaProvider)
  registerSpeakersIpc(recordingService.getRecordingsBaseDir())

  const wasConnected = await calendarService.initialize()
  if (wasConnected) {
    calendarService.startSync((events) => {
      cachedEvents = events
      updateTrayMenu()
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('calendar:events-updated', events)
      }
    })
  }

  createWindow()

  // System tray — show upcoming meetings, open app, quit
  const showWindow = () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      wins[0].show()
      wins[0].focus()
    } else {
      createWindow()
    }
  }
  createTray(() => cachedEvents, showWindow)

  detectionService.start()

  // Start Ollama + pull model in the background — don't block the window
  ollamaManager.startAndPull()
    .then(() => {
      ollamaSetupState.phase = 'ready'
      ollamaSetupState.percent = 100
      broadcastOllamaStatus()
    })
    .catch((err) => {
      ollamaSetupState.phase = 'error'
      ollamaSetupState.error = err instanceof Error ? err.message : String(err)
      broadcastOllamaStatus()
      console.error('Failed to start Ollama:', err)
    })

  // Migrate legacy ~/AutoDoc/ data, then encrypt unencrypted files, then enqueue work
  cleanupTempFiles().catch(() => {})
  migrateDataDir()
    .catch((err) => console.error('Data dir migration failed:', err))
    .then(() => migrateRecordings(recordingService.getRecordingsBaseDir()))
    .catch((err) => console.error('Encryption migration failed:', err))
    .finally(() => {
      transcriptionService.scanAndEnqueuePending()
      segmentationService.scanAndEnqueuePending()
    })

  app.on('activate', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length === 0) {
      createWindow()
    } else {
      wins[0].show()
      wins[0].focus()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  ollamaManager?.stop()
})

app.on('window-all-closed', () => {
  // Don't quit — the tray keeps the app alive
})

/**
 * One-time migration: move data from legacy ~/AutoDoc/ to app.getPath('userData').
 * Moves recordings/, models/, and ollama-data/ subdirectories.
 */
async function migrateDataDir(): Promise<void> {
  const legacyBase = join(app.getPath('home'), 'AutoDoc')
  try {
    await access(legacyBase)
  } catch {
    return // No legacy dir, nothing to migrate
  }

  const newBase = app.getPath('userData')
  const subdirs = ['recordings', 'models', 'ollama-data']

  for (const subdir of subdirs) {
    const src = join(legacyBase, subdir)
    const dest = join(newBase, subdir)
    try {
      await access(src)
    } catch {
      continue // Subdir doesn't exist in legacy location
    }
    try {
      await access(dest)
      // Dest already exists — merge by moving individual entries
      const entries = await readdir(src)
      for (const entry of entries) {
        const entrySrc = join(src, entry)
        const entryDest = join(dest, entry)
        try {
          await access(entryDest)
          // Already exists at dest, skip
        } catch {
          await rename(entrySrc, entryDest)
        }
      }
      // Remove legacy subdir if now empty
      const remaining = await readdir(src)
      if (remaining.length === 0) await rmdir(src)
    } catch {
      // Dest doesn't exist — simple rename
      await mkdir(newBase, { recursive: true })
      await rename(src, dest)
    }
  }

  // Remove legacy base dir if now empty
  try {
    const remaining = await readdir(legacyBase)
    if (remaining.length === 0) await rmdir(legacyBase)
  } catch {
    // Ignore
  }

  console.log('Migrated data from ~/AutoDoc/ to', newBase)
}
