import { app, BrowserWindow, ipcMain, shell, systemPreferences, desktopCapturer } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CalendarService } from './services/calendar'
import { registerCalendarIpc } from './ipc/calendar-ipc'
import { RecordingService } from './services/recording'
import { registerRecordingIpc } from './ipc/recording-ipc'
import { WhisperManager } from './services/whisper-manager'
import { AudioConverter } from './services/audio-converter'
import { TranscriptionService } from './services/transcription'
import { registerTranscriptionIpc } from './ipc/transcription-ipc'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
  registerCalendarIpc(calendarService)

  const recordingService = new RecordingService()
  const whisperManager = new WhisperManager()
  const audioConverter = new AudioConverter()
  const transcriptionService = new TranscriptionService(
    whisperManager,
    audioConverter,
    recordingService.getRecordingsBaseDir(),
  )
  registerRecordingIpc(recordingService, transcriptionService)
  registerTranscriptionIpc(transcriptionService)

  const wasConnected = await calendarService.initialize()
  if (wasConnected) {
    calendarService.startSync((events) => {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('calendar:events-updated', events)
      }
    })
  }

  createWindow()
  transcriptionService.scanAndEnqueuePending()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
