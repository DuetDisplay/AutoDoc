import { app, BrowserWindow, ipcMain, shell, systemPreferences, powerMonitor } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { readdirSync, rmSync } from 'fs'
import { stat, readdir, rename, mkdir, access, rmdir } from 'fs/promises'
import { migrateRecordings, cleanupTempFiles, initializeEncryption } from './services/crypto'
import { startRecordingMediaHttpServer, stopRecordingMediaHttpServer } from './services/media-http-server'
import { is } from '@electron-toolkit/utils'
import { CalendarManager } from './services/calendar-manager'
import { registerCalendarIpc } from './ipc/calendar-ipc'
import { RecordingService } from './services/recording'
import { registerRecordingIpc } from './ipc/recording-ipc'
import { WhisperManager } from './services/whisper-manager'
import { AudioConverter } from './services/audio-converter'
import { TranscriptionService } from './services/transcription'
import { registerTranscriptionIpc } from './ipc/transcription-ipc'
import { OllamaProvider } from './services/llm'
import { OllamaManager } from './services/ollama-manager'
import { SegmentationService } from './services/segmentation'
import { registerLlmIpc } from './ipc/llm-ipc'
import { DetectionService } from './services/detection'
import { registerSearchIpc } from './ipc/search-ipc'
import { registerChatIpc } from './ipc/chat-ipc'
import { registerSpeakersIpc } from './ipc/speakers-ipc'
import { PrefsStore, readInitialAnalyticsConsent } from './services/prefs-store'
import { registerPrefsIpc } from './ipc/prefs-ipc'
import { registerWhisperIpc } from './ipc/whisper-ipc'
import { createTray, updateTrayMenu } from './services/tray'
import { logAutodocFailure } from './services/autodoc-log'
import type { AppRuntimeInfo, AppStorageInfo, OllamaSetupStatus, WhisperSetupStatus, RecordingMediaPlayerErrorReport } from '../shared/types'
import { initAutoUpdater, getUpdateStatus, checkForUpdates, installUpdate } from './services/auto-updater'
import { initSentryReporter, resetSentryScopes, setGlobalContext, setGlobalTag } from './services/sentry-reporter'
import { clearDiagnosticTrail, recordMainDiagnosticAction, recordRendererDiagnosticAction } from './services/diagnostic-trail'
import { normalizeSentryBreadcrumb } from '../shared/sentry-breadcrumbs'
import {
  buildSingleInstanceLaunchData,
  enforceInstalledApplicationPolicy,
  handleSecondInstanceLaunch,
  traceInstallPolicy,
} from './services/application-install'
import { focusMainWindow, registerMainWindow } from './services/main-window'
import {
  getE2EOllamaStatus,
  getE2EPermissions,
  getE2EPlatform,
  getE2EWhisperStatus,
  setE2EOllamaStatus,
  setE2EWhisperStatus,
} from './services/e2e-fixtures'
import { clearDownloadedComponents, getAppStorageInfo } from './services/storage-manager'
import { getResetLocalDataTargets } from './services/reset-local-data'

// Ensure consistent app name for safeStorage keychain service across dev and production
app.setName('AutoDoc')
const isE2E = process.env.AUTODOC_E2E === '1'
const testUserDataDir = process.env.AUTODOC_TEST_USER_DATA_DIR
const isRealSetupTest = process.env.AUTODOC_TEST_REAL_SETUP === '1'
const RESET_LOCAL_DATA_ARG = '--reset-local-data'

if (testUserDataDir) {
  app.setPath('userData', testUserDataDir)
} else if (isE2E) {
  app.setPath('userData', join(app.getPath('temp'), `autodoc-e2e-${process.pid}`))
}

if (process.argv.includes(RESET_LOCAL_DATA_ARG)) {
  const userDataPath = app.getPath('userData')
  const appDataPath = app.getPath('appData')
  for (const targetPath of getResetLocalDataTargets({
    userDataPath,
    appDataPath,
    testUserDataDir,
    isE2E,
    isRealSetupTest,
  })) {
    rmSync(targetPath, { recursive: true, force: true })
  }
  process.argv = process.argv.filter((arg) => arg !== RESET_LOCAL_DATA_ARG)
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.autodoc.app')
}
if (process.platform === 'darwin' && is.dev) {
  // Electron 39+ uses macOS CoreAudio Tap for desktop audio on 14.2+.
  // When we launch from Terminal/IDE in dev, the parent app often lacks the
  // required NSAudioCaptureUsageDescription key, so force the older screen/system
  // audio permission flow for local testing.
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare')
}

const SENTRY_DSN = process.env.AUTODOC_SENTRY_DSN
const shouldAllowSentryInEnv = !isE2E && (!is.dev || !!process.env.AUTODOC_SENTRY_DEV)
const homeDir = homedir()

function deepScrub<T>(value: T, scrubString: (input: string) => string): T {
  if (typeof value === 'string') {
    return scrubString(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepScrub(item, scrubString)) as T
  }
  if (value && typeof value === 'object') {
    const scrubbed: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      scrubbed[key] = deepScrub(nestedValue, scrubString)
    }
    return scrubbed as T
  }
  return value
}

// Set dock icon in dev (production uses the bundled .icns)
if (is.dev && process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(join(__dirname, '../../build/icon.png'))
}

let ollamaManager: OllamaManager | null = null
let isQuitting = false
let mainSentry: typeof import('@sentry/electron/main') | null = null
let mainSentryEnabled = false
let onMainSentryReady: (() => void) | null = null
let analyticsConsentEnabled = false
const gotSingleInstanceLock = app.requestSingleInstanceLock(buildSingleInstanceLaunchData())
traceInstallPolicy('index: single-instance lock result', {
  gotLock: gotSingleInstanceLock,
  execPath: process.execPath,
  pid: process.pid,
})
const PENDING_RECOVERY_INTERVAL_MS = 2 * 60 * 1000
const require = createRequire(import.meta.url)

function scheduleWindowsE2ETestResetCleanup(targetPaths: string[]): void {
  const escapedTargets = targetPaths
    .map((targetPath) => `'${targetPath.replaceAll("'", "''")}'`)
    .join(', ')
  const script = [
    `$targets = @(${escapedTargets})`,
    'for ($attempt = 0; $attempt -lt 60; $attempt++) {',
    '  $remaining = @($targets | Where-Object { Test-Path -LiteralPath $_ })',
    '  if ($remaining.Count -eq 0) { exit 0 }',
    '  foreach ($target in $remaining) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }',
    '  Start-Sleep -Milliseconds 200',
    '}',
  ].join('; ')

  spawn('powershell', [
    '-NoProfile',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}

function clearWindowsE2ETestUserDataContents(userDataPath: string): void {
  try {
    const entries = readdirSync(userDataPath, { withFileTypes: true })
    for (const entry of entries) {
      try {
        rmSync(join(userDataPath, entry.name), { recursive: true, force: true })
      } catch {
        // Some Chromium-managed files may still be locked during shutdown.
      }
    }
  } catch {
    // Best-effort only. The detached cleanup process removes any leftovers after exit.
  }
}

type MainSentryRuntimeModule = typeof import('@sentry/electron/main') & {
  getDefaultIntegrations(options: Record<string, unknown>): Array<{ name: string }>
}

function initializeMainSentry(): void {
  if (!SENTRY_DSN || !shouldAllowSentryInEnv || mainSentryEnabled) return

  try {
    if (!mainSentry) {
      mainSentry = require('@sentry/electron/main') as typeof import('@sentry/electron/main')
    }

    const sentryRuntime = mainSentry as MainSentryRuntimeModule
    const scrubString = (input: string): string => input.replaceAll(homeDir, '[home]')
    const integrations = sentryRuntime
      .getDefaultIntegrations({ sendDefaultPii: false })
      .filter((integration) => integration.name !== 'MainProcessSession')

    const initOptions = {
      dsn: SENTRY_DSN,
      environment: is.dev ? 'development' : 'production',
      release: `autodoc@${app.getVersion()}`,
      enabled: true,
      sendDefaultPii: false,
      integrations,
      beforeBreadcrumb: normalizeSentryBreadcrumb,
      beforeSend(event) {
        if (!analyticsConsentEnabled) {
          return null
        }
        delete event.server_name
        return deepScrub(event, scrubString)
      },
    }

    sentryRuntime.init(initOptions as Parameters<typeof sentryRuntime.init>[0])
    initSentryReporter(mainSentry)
    mainSentryEnabled = true
    onMainSentryReady?.()
  } catch (err) {
    console.warn('Failed to initialize Sentry:', err)
  }
}

if (!gotSingleInstanceLock) {
  traceInstallPolicy('index: secondary instance exiting (lock failed)')
  app.exit(0)
  // app.exit(0) may not terminate on macOS when app.whenReady() hasn't fired yet
  setTimeout(() => process.exit(0), 2000).unref()
} else {
  try {
    analyticsConsentEnabled = readInitialAnalyticsConsent() === true
  } catch (err) {
    console.warn('Failed to read initial analytics consent for Sentry:', err)
  }

  initializeMainSentry()

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    void handleSecondInstanceLaunch(additionalData, argv).then((handled) => {
      if (!handled) {
        focusMainWindow()
      }
    }).catch((error) => {
      console.warn('Failed to handle second AutoDoc launch:', error)
      focusMainWindow()
    })
  })
}

function createWindow(): void {
  recordMainDiagnosticAction({ category: 'app', action: 'main_window_created' })
  const windowIcon = is.dev
    ? join(__dirname, process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png')
    : undefined

  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'AutoDoc',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#FAFAF7',
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  registerMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Hide to tray instead of closing (unless user is quitting)
  mainWindow.on('close', (e) => {
    if (!isQuitting && !isE2E) {
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
  if (!gotSingleInstanceLock) return
  if (!(await enforceInstalledApplicationPolicy())) return

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('diagnostics:record-action', (_event, payload) => {
    recordRendererDiagnosticAction(payload)
  })
  ipcMain.handle('diagnostics:clear-trail', () => {
    clearDiagnosticTrail()
  })
  recordMainDiagnosticAction({ category: 'app', action: 'app_ready' })

  const prefsStore = new PrefsStore()
  const runtimeContext = {
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
  }
  let whisperContext: Record<string, unknown> = { ready: false, modelFilename: null }
  let ollamaContext: Record<string, unknown> = { ready: false, modelName: null }
  let calendarContext: Record<string, unknown> = { connected: false, providerCount: 0, accountCount: 0 }

  const applyCurrentSentryContext = (): void => {
    setGlobalTag('platform', process.platform)
    setGlobalTag('arch', process.arch)
    setGlobalTag('app_version', app.getVersion())
    setGlobalTag('electron_version', process.versions.electron)
    setGlobalContext('runtime', runtimeContext)
    setGlobalContext('whisper', whisperContext)
    setGlobalContext('ollama', ollamaContext)
    setGlobalContext('calendar', calendarContext)
  }
  onMainSentryReady = applyCurrentSentryContext
  if (mainSentryEnabled) {
    applyCurrentSentryContext()
  }

  const updateWhisperSentryContext = (context: Record<string, unknown>): void => {
    whisperContext = context
    applyCurrentSentryContext()
  }

  const updateOllamaSentryContext = (context: Record<string, unknown>): void => {
    ollamaContext = context
    applyCurrentSentryContext()
  }

  const updateCalendarSentryContext = (context: Record<string, unknown>): void => {
    calendarContext = context
    applyCurrentSentryContext()
  }

  registerPrefsIpc(prefsStore, (enabled) => {
    analyticsConsentEnabled = enabled
    if (mainSentryEnabled) {
      resetSentryScopes()
      applyCurrentSentryContext()
    }
  })

  // Auto-updater
  if (!isE2E) {
    initAutoUpdater()
  }
  ipcMain.handle('updater:get-status', () => getUpdateStatus())
  ipcMain.handle('updater:check', () => {
    if (!isE2E) {
      checkForUpdates()
    }
  })
  ipcMain.handle('updater:install', () => {
    if (!isE2E) {
      installUpdate()
    }
  })

  ipcMain.handle('permissions:check', async () => {
    if (isE2E) {
      return getE2EPermissions()
    }

    if (process.platform === 'darwin') {
      const microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted'
      const screen = systemPreferences.getMediaAccessStatus('screen') === 'granted'
      return { screen, microphone }
    }
    // On Windows/Linux, permissions are generally granted by default
    return { screen: true, microphone: true }
  })

  ipcMain.handle('permissions:open-settings', (_event, panel: 'screen' | 'microphone') => {
    if (isE2E) {
      return
    }

    if (process.platform === 'darwin') {
      if (panel === 'screen') {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      } else {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }
  })

  const calendarManager = new CalendarManager()
  registerCalendarIpc(calendarManager, (events) => {
    cachedEvents = events
    updateTrayMenu()
  }, (connected) => {
    updateCalendarSentryContext({
      connected,
      providerCount: connected ? new Set(calendarManager.getAccounts().map((account) => account.provider)).size : 0,
      accountCount: calendarManager.getAccounts().length,
    })
  })

  const recordingService = new RecordingService()

  let recordingMediaBaseUrl: string | null = null
  try {
    const port = await startRecordingMediaHttpServer(() => recordingService.getRecordingsBaseDir())
    recordingMediaBaseUrl = `http://127.0.0.1:${port}`
  } catch {
    // Failure already reported via logAutodocFailure inside startRecordingMediaHttpServer
  }

  ipcMain.handle('recording:get-media', async (_event, meetingId: string) => {
    const baseDir = recordingService.getRecordingsBaseDir()
    const videoPath = join(baseDir, meetingId, 'screen.webm')
    const micPath = join(baseDir, meetingId, 'mic.webm')
    const systemPath = join(baseDir, meetingId, 'system.webm')
    const legacyAudioPath = join(baseDir, meetingId, 'audio.webm')
    const hasVideo = await stat(videoPath).then(() => true).catch(() => false)
    const hasMicAudio = await stat(micPath).then(() => true).catch(() => false)
    const hasSystemAudio = await stat(systemPath).then(() => true).catch(() => false)
    const hasLegacyAudio = await stat(legacyAudioPath).then(() => true).catch(() => false)
    const audioFile = hasSystemAudio ? 'system.webm' : hasMicAudio ? 'mic.webm' : hasLegacyAudio ? 'audio.webm' : undefined
    return {
      hasVideo,
      hasAudio: Boolean(audioFile),
      audioFile,
      mediaBaseUrl: recordingMediaBaseUrl ?? undefined,
    }
  })

  ipcMain.handle('recording:report-media-player-error', (_event, payload: RecordingMediaPlayerErrorReport) => {
    logAutodocFailure({
      area: 'recording',
      message: 'Renderer media element error (video/audio)',
      meetingId: payload.meetingId,
      context: { surface: 'renderer', ...payload },
    })
  })

  const whisperManager = new WhisperManager()
  const audioConverter = new AudioConverter()
  const transcriptionService = new TranscriptionService(
    whisperManager,
    audioConverter,
    recordingService.getRecordingsBaseDir(),
    calendarManager,
    (meetingId) => {
      const state = recordingService.getState()
      return state.isRecording && state.meetingId === meetingId
    },
  )
  ollamaManager = new OllamaManager()
  const managedOllamaManager = ollamaManager

  // Mutable state tracking Ollama setup progress
  const ollamaSetupState: OllamaSetupStatus = isE2E
    ? getE2EOllamaStatus()
    : { phase: 'starting', percent: 0 }
  let lastSuccessfulOllamaPhase: OllamaSetupStatus['phase'] = isE2E ? ollamaSetupState.phase : 'starting'

  function broadcastOllamaStatus(): void {
    updateOllamaSentryContext({
      ready: ollamaSetupState.phase === 'ready',
      modelName: managedOllamaManager.getModel(),
      phase: ollamaSetupState.phase,
      failedStep: ollamaSetupState.failedStep ?? null,
    })
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('ollama:setup-progress', { ...ollamaSetupState })
    }
  }

  managedOllamaManager.on('download-start', () => {
    lastSuccessfulOllamaPhase = 'downloading'
    ollamaSetupState.phase = 'downloading'
    ollamaSetupState.percent = 0
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  managedOllamaManager.on('download-progress', (data: { percent: number }) => {
    lastSuccessfulOllamaPhase = 'downloading'
    ollamaSetupState.phase = 'downloading'
    ollamaSetupState.percent = data.percent
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  managedOllamaManager.on('download-complete', () => {
    lastSuccessfulOllamaPhase = 'pulling'
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = 0
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  managedOllamaManager.on('pull-start', () => {
    lastSuccessfulOllamaPhase = 'pulling'
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = 0
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  managedOllamaManager.on('pull-progress', (data: { percent: number }) => {
    lastSuccessfulOllamaPhase = 'pulling'
    ollamaSetupState.phase = 'pulling'
    ollamaSetupState.percent = data.percent
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  managedOllamaManager.on('pull-complete', () => {
    lastSuccessfulOllamaPhase = 'ready'
    ollamaSetupState.phase = 'ready'
    ollamaSetupState.percent = 100
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  })

  let ollamaRecoveryPromise: Promise<void> | null = null

  const ensureOllamaRunning = (): void => {
    if (ollamaRecoveryPromise) return

    managedOllamaManager.resetReady()

    lastSuccessfulOllamaPhase = 'starting'
    ollamaSetupState.phase = 'starting'
    ollamaSetupState.percent = 0
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()

    ollamaRecoveryPromise = managedOllamaManager.startAndPull()
      .then(() => {
        lastSuccessfulOllamaPhase = 'ready'
        ollamaSetupState.phase = 'ready'
        ollamaSetupState.percent = 100
        delete ollamaSetupState.error
        delete ollamaSetupState.failedStep
        broadcastOllamaStatus()
      })
      .catch((err) => {
        ollamaSetupState.phase = 'error'
        ollamaSetupState.percent = 0
        ollamaSetupState.error = err instanceof Error ? err.message : String(err)
        ollamaSetupState.failedStep = lastSuccessfulOllamaPhase === 'error' ? 'starting' : lastSuccessfulOllamaPhase
        broadcastOllamaStatus()
        logAutodocFailure({
          area: 'ollama',
          message: 'Failed to start managed Ollama server',
          error: err,
        })
        console.error('Failed to start Ollama:', err)
      })
      .finally(() => {
        ollamaRecoveryPromise = null
      })
  }

  const ollamaProvider = new OllamaProvider(managedOllamaManager.getBaseUrl(), managedOllamaManager.getModel())
  const segmentationService = new SegmentationService(
    ollamaProvider,
    ollamaManager,
    recordingService.getRecordingsBaseDir(),
  )
  ipcMain.handle('app:get-runtime-info', (): AppRuntimeInfo => ({
    platform: isE2E ? getE2EPlatform() : process.platform,
    storagePath: app.getPath('userData'),
    whisperModel: whisperManager.getModelName(),
    ollamaModel: managedOllamaManager.getModel(),
  }))
  ipcMain.handle('app:get-storage-info', async (): Promise<AppStorageInfo> => {
    return await getAppStorageInfo()
  })
  ipcMain.handle('app:clear-downloaded-components', async (): Promise<AppStorageInfo> => {
    managedOllamaManager.stop()
    managedOllamaManager.resetReady()
    await clearDownloadedComponents()
    return await getAppStorageInfo()
  })
  ipcMain.handle('app:reset-local-data', (): void => {
    if (recordingService.getState().isRecording) {
      throw new Error('Stop the current recording before deleting local AutoDoc data.')
    }

    managedOllamaManager.stop()
    managedOllamaManager.resetReady()

    if (process.platform === 'win32' && isE2E && testUserDataDir) {
      const userDataPath = app.getPath('userData')
      const targetPaths = getResetLocalDataTargets({
        userDataPath,
        appDataPath: app.getPath('appData'),
        testUserDataDir,
        isE2E,
        isRealSetupTest,
      })
      // In Windows-hosted E2E runs, deleting the temp profile after process exit
      // avoids relaunching an unmanaged second app instance that Playwright can't own.
      clearWindowsE2ETestUserDataContents(userDataPath)
      scheduleWindowsE2ETestResetCleanup(targetPaths)
      setTimeout(() => app.exit(0), 100)
      return
    }

    const relaunchArgs = process.argv
      .slice(1)
      .filter((arg) => arg !== RESET_LOCAL_DATA_ARG)

    app.relaunch({ args: [...relaunchArgs, RESET_LOCAL_DATA_ARG] })
    setTimeout(() => app.exit(0), 100)
  })
  let pendingRecoveryPromise: Promise<unknown> | null = null

  const recoverPendingWork = (): void => {
    if (pendingRecoveryPromise) return

    pendingRecoveryPromise = Promise.all([
      transcriptionService.scanAndEnqueuePending(),
      segmentationService.scanAndEnqueuePending(),
    ])
      .catch((err) => {
        logAutodocFailure({
          area: 'app',
          message: 'Pending meeting recovery failed',
          error: err,
        })
        console.error('Pending meeting recovery failed:', err)
      })
      .finally(() => {
        pendingRecoveryPromise = null
      })
  }

  transcriptionService.onComplete((meetingId) => {
    segmentationService.enqueue(meetingId)
  })

  let cachedEvents: import('../shared/types').CalendarEvent[] = []

  const detectionService = new DetectionService(
    recordingService,
    () => cachedEvents,
  )

  ipcMain.handle('detection:dismiss', () => {
    detectionService.dismissPrompt()
  })

  // Mutable state tracking Whisper setup progress
  const whisperSetupState: WhisperSetupStatus = isE2E
    ? getE2EWhisperStatus()
    : { phase: 'checking', percent: 0 }
  let lastSuccessfulWhisperPhase: WhisperSetupStatus['phase'] = isE2E ? whisperSetupState.phase : 'checking'
  const getWhisperFailedStep = (): WhisperSetupStatus['failedStep'] => (
    lastSuccessfulWhisperPhase === 'downloading-ffmpeg'
    || lastSuccessfulWhisperPhase === 'downloading-model'
    || lastSuccessfulWhisperPhase === 'ready'
      ? lastSuccessfulWhisperPhase
      : 'downloading-whisper'
  )

  whisperManager.on('setup-status', (status: WhisperSetupStatus) => {
    if (status.phase !== 'error') {
      lastSuccessfulWhisperPhase = status.phase
    }
    whisperSetupState.phase = status.phase
    whisperSetupState.percent = status.percent
    whisperSetupState.error = status.error
    whisperSetupState.failedStep = status.phase === 'error' ? getWhisperFailedStep() : undefined
    updateWhisperSentryContext({
      ready: status.phase === 'ready',
      modelFilename: whisperManager.getModelInfo().filename,
      whisperVersion: 'v1.8.4',
      phase: status.phase,
      failedStep: whisperSetupState.failedStep ?? null,
    })
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('whisper:setup-progress', { ...whisperSetupState })
    }
  })

  if (isE2E) {
    ipcMain.handle('e2e:set-whisper-status', (_event, status: WhisperSetupStatus) => {
      const nextStatus = setE2EWhisperStatus(status)
      whisperSetupState.phase = nextStatus.phase
      whisperSetupState.percent = nextStatus.percent
      whisperSetupState.error = nextStatus.error
      whisperSetupState.failedStep = nextStatus.failedStep
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('whisper:setup-progress', { ...whisperSetupState })
      }
    })

    ipcMain.handle('e2e:set-ollama-status', (_event, status: OllamaSetupStatus) => {
      const nextStatus = setE2EOllamaStatus(status)
      ollamaSetupState.phase = nextStatus.phase
      ollamaSetupState.percent = nextStatus.percent
      ollamaSetupState.error = nextStatus.error
      ollamaSetupState.failedStep = nextStatus.failedStep
      broadcastOllamaStatus()
    })
  }

  const { stopActiveRecording } = registerRecordingIpc(
    recordingService,
    transcriptionService,
    whisperManager,
    calendarManager,
  )
  registerTranscriptionIpc(transcriptionService)
  registerLlmIpc(
    segmentationService,
    managedOllamaManager,
    ollamaProvider,
    () => ({ ...ollamaSetupState }),
    ensureOllamaRunning,
  )
  registerWhisperIpc(whisperManager, () => ({ ...whisperSetupState }))
  registerSearchIpc(recordingService.getRecordingsBaseDir())
  registerChatIpc(recordingService.getRecordingsBaseDir(), managedOllamaManager, ollamaProvider, calendarManager)
  registerSpeakersIpc(recordingService.getRecordingsBaseDir())

  const restoredAccounts = await calendarManager.initialize()
  updateCalendarSentryContext({
    connected: restoredAccounts.length > 0,
    providerCount: new Set(restoredAccounts.map((account) => account.provider)).size,
    accountCount: restoredAccounts.length,
  })
  if (restoredAccounts.length > 0) {
    calendarManager.startSync((events) => {
      cachedEvents = events
      updateTrayMenu()
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('calendar:events-updated', events)
      }
    })
  }

  cleanupTempFiles().catch(() => {})
  try {
    await migrateDataDir()
  } catch (err) {
    logAutodocFailure({
      area: 'app',
      message: 'Data dir migration failed',
      error: err,
    })
    console.error('Data dir migration failed:', err)
  }

  try {
    await initializeEncryption(recordingService.getRecordingsBaseDir())
  } catch (err) {
    logAutodocFailure({
      area: 'app',
      message: 'Encryption key initialization failed',
      error: err,
    })
    console.error('Encryption key initialization failed:', err)
  }

  try {
    await migrateRecordings(recordingService.getRecordingsBaseDir())
  } catch (err) {
    logAutodocFailure({
      area: 'app',
      message: 'Encryption migration failed',
      error: err,
    })
    console.error('Encryption migration failed:', err)
  }

  createWindow()

  // System tray — show upcoming meetings, open app, quit
  if (!isE2E) {
    const showWindow = () => {
      if (!focusMainWindow()) {
        createWindow()
      }
    }
    if (!isRealSetupTest) {
      createTray(() => cachedEvents, showWindow, {
        getIsRecording: () => recordingService.getState().isRecording,
        stopRecording: () => {
          if (!recordingService.getState().isRecording) return
          try {
            stopActiveRecording()
          } catch {
            // Failure already logged in recording IPC
          }
        },
      })
    }

    recoverPendingWork()
    if (!isRealSetupTest) {
      detectionService.start()
    }

    // Start whisper tools + model download in the background — don't block the window
    whisperManager.startSetup()
      .then(() => {
        lastSuccessfulWhisperPhase = 'ready'
        whisperSetupState.phase = 'ready'
        whisperSetupState.percent = 100
        delete whisperSetupState.error
        delete whisperSetupState.failedStep
        updateWhisperSentryContext({
          ready: true,
          modelFilename: whisperManager.getModelInfo().filename,
          whisperVersion: 'v1.8.4',
          phase: 'ready',
          failedStep: null,
        })
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          win.webContents.send('whisper:setup-progress', { ...whisperSetupState })
        }
      })
      .catch((err) => {
        whisperSetupState.phase = 'error'
        whisperSetupState.error = err instanceof Error ? err.message : String(err)
        whisperSetupState.failedStep = getWhisperFailedStep()
        updateWhisperSentryContext({
          ready: false,
          modelFilename: whisperManager.getModelInfo().filename,
          whisperVersion: 'v1.8.4',
          phase: 'error',
          failedStep: whisperSetupState.failedStep ?? null,
        })
        const windows = BrowserWindow.getAllWindows()
        for (const win of windows) {
          win.webContents.send('whisper:setup-progress', { ...whisperSetupState })
        }
        logAutodocFailure({
          area: 'whisper',
          message: 'Failed to set up whisper tools',
          error: err,
        })
        console.error('Failed to set up whisper tools:', err)
      })

    // Start Ollama + pull model in the background — don't block the window
    ensureOllamaRunning()

    if (!isRealSetupTest) {
      powerMonitor.on('resume', () => {
        ensureOllamaRunning()
        recoverPendingWork()
      })

      powerMonitor.on('unlock-screen', () => {
        ensureOllamaRunning()
        recoverPendingWork()
      })

      setInterval(() => {
        recoverPendingWork()
      }, PENDING_RECOVERY_INTERVAL_MS)
    }
  }

  app.on('activate', () => {
    if (!isE2E) {
      recoverPendingWork()
    }
    if (!focusMainWindow()) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
  ollamaManager?.stop()
  stopRecordingMediaHttpServer()
})

app.on('window-all-closed', () => {
  if (!isE2E && !isRealSetupTest) {
    // Don't quit — the tray keeps the app alive
    return
  }
  app.quit()
})

process.on('uncaughtException', (error) => {
  logAutodocFailure({
    area: 'app',
    message: 'Uncaught exception in main process',
    error,
  })
  console.error('Uncaught exception in main process:', error)
})

process.on('unhandledRejection', (reason) => {
  logAutodocFailure({
    area: 'app',
    message: 'Unhandled rejection in main process',
    error: reason,
  })
  console.error('Unhandled rejection in main process:', reason)
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
