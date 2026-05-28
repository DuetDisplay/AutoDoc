import { app, BrowserWindow, ipcMain, shell, systemPreferences, powerMonitor } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { execFileSync, spawn } from 'child_process'
import { createRequire } from 'module'
import { readdirSync, rmSync } from 'fs'
import { stat, readdir, rename, mkdir, access, rmdir, writeFile } from 'fs/promises'
import {
  migrateRecordings,
  cleanupTempFiles,
  initializeEncryption,
  encryptJSON
} from './services/crypto'
import {
  startRecordingMediaHttpServer,
  stopRecordingMediaHttpServer
} from './services/media-http-server'
import { is } from '@electron-toolkit/utils'
import { CalendarManager } from './services/calendar-manager'
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
import { OllamaSetupCoordinator } from './services/ollama-setup-coordinator'
import { SegmentationService } from './services/segmentation'
import { LocalProcessingCoordinator } from './services/local-processing-coordinator'
import { registerLlmIpc } from './ipc/llm-ipc'
import { DetectionService } from './services/detection'
import { registerSearchIpc } from './ipc/search-ipc'
import { registerChatIpc } from './ipc/chat-ipc'
import { registerSpeakersIpc } from './ipc/speakers-ipc'
import {
  PrefsStore,
  readInitialAnalyticsConsent,
  readInitialDiagnosticLogUploadConsent
} from './services/prefs-store'
import { registerPrefsIpc } from './ipc/prefs-ipc'
import { registerWhisperIpc } from './ipc/whisper-ipc'
import { createTray, updateTrayMenu } from './services/tray'
import {
  logAutodocEvent,
  logAutodocFailure,
  setDiagnosticLogUploadForErrorsEnabled,
  flushAutodocLogWrites
} from './services/autodoc-log'
import type {
  AppRuntimeInfo,
  AppStorageInfo,
  OllamaSetupStatus,
  WhisperSetupStatus,
  DiarizationSetupStatus,
  RecordingMediaPlayerErrorReport,
  SegmentationDiagnosticPayload
} from '../shared/types'
import type { E2EDetectionState } from '../shared/e2e'
import {
  initAutoUpdater,
  getUpdateStatus,
  checkForUpdates,
  installUpdate
} from './services/auto-updater'
import {
  initSentryReporter,
  resetSentryScopes,
  setGlobalContext,
  setGlobalTag
} from './services/sentry-reporter'
import {
  clearDiagnosticTrail,
  recordMainDiagnosticAction,
  recordRendererDiagnosticAction
} from './services/diagnostic-trail'
import { normalizeSentryBreadcrumb } from '../shared/sentry-breadcrumbs'
import {
  buildSingleInstanceLaunchData,
  enforceInstalledApplicationPolicy,
  handleSecondInstanceLaunch,
  traceInstallPolicy
} from './services/application-install'
import { focusMainWindow, registerMainWindow } from './services/main-window'
import {
  getE2EDetectionState,
  getE2EOllamaStatus,
  getE2EPermissionRequestState,
  getE2EPermissions,
  getE2EPlatform,
  requestE2EMicrophoneAccess,
  setE2EDetectionState,
  setE2EOllamaStatus,
  setE2EWhisperStatus
} from './services/e2e-fixtures'
import {
  clearDownloadedComponents,
  getAppStorageInfo,
  getStorageDiagnostics
} from './services/storage-manager'
import { getResetLocalDataTargets } from './services/reset-local-data'
import { createSentryStubRuntime } from './services/sentry-stub'
import { notifyNotesReady } from './services/notes-ready-notifier'
import { readMetadata } from './services/calendar-matcher'
import { getScopedTestUserDataDir } from './services/test-runtime'
import { shouldSuppressNotificationActivation } from './notification-window'

// Ensure consistent app name for safeStorage keychain service across dev and production
app.setName('AutoDoc')
const isE2E = process.env.AUTODOC_E2E === '1'
const testUserDataDir = getScopedTestUserDataDir()
const isTestRuntime = process.env.NODE_ENV === 'test' || process.env.AUTODOC_TEST_MODE === '1'
const isRealSetupTest = process.env.AUTODOC_TEST_REAL_SETUP === '1'
const skipInstalledApplicationPolicy =
  process.env.AUTODOC_SKIP_INSTALL_POLICY === '1' && (is.dev || isE2E || isRealSetupTest)
const RESET_LOCAL_DATA_ARG = '--reset-local-data'
const EXPECTED_APP_ID = 'com.kairos.autodoc'

interface MacBundleMetadata {
  bundlePath: string | null
  infoPlistPath: string | null
  bundleIdentifier: string | null
  bundleName: string | null
  bundleDisplayName: string | null
}

let cachedMacBundleMetadata: MacBundleMetadata | null | undefined

function readMacBundlePlistValue(infoPlistPath: string, key: string): string | null {
  try {
    const value = execFileSync('/usr/bin/defaults', ['read', infoPlistPath, key], {
      encoding: 'utf8'
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function getMacBundleMetadata(): MacBundleMetadata | null {
  if (process.platform !== 'darwin') return null
  if (cachedMacBundleMetadata !== undefined) return cachedMacBundleMetadata

  const executablePath = app.getPath('exe')
  const contentsMarker = '/Contents/MacOS/'
  const markerIndex = executablePath.indexOf(contentsMarker)

  if (markerIndex === -1) {
    cachedMacBundleMetadata = null
    return cachedMacBundleMetadata
  }

  const bundlePath = executablePath.slice(0, markerIndex)
  const infoPlistPath = join(bundlePath, 'Contents', 'Info.plist')

  cachedMacBundleMetadata = {
    bundlePath,
    infoPlistPath,
    bundleIdentifier: readMacBundlePlistValue(infoPlistPath, 'CFBundleIdentifier'),
    bundleName: readMacBundlePlistValue(infoPlistPath, 'CFBundleName'),
    bundleDisplayName: readMacBundlePlistValue(infoPlistPath, 'CFBundleDisplayName')
  }

  return cachedMacBundleMetadata
}

if (testUserDataDir) {
  app.setPath('userData', testUserDataDir)
} else if (isE2E) {
  app.setPath('userData', join(app.getPath('temp'), `autodoc-e2e-${process.pid}`))
} else if (is.dev) {
  // Keep local dev/testing isolated from the installed app's recordings, models, and key store.
  app.setPath('userData', join(app.getPath('appData'), 'AutoDoc Dev'))
}

if (process.argv.includes(RESET_LOCAL_DATA_ARG)) {
  const userDataPath = app.getPath('userData')
  const appDataPath = app.getPath('appData')
  for (const targetPath of getResetLocalDataTargets({
    userDataPath,
    appDataPath,
    testUserDataDir: testUserDataDir ?? undefined,
    isE2E,
    isRealSetupTest
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
const SENTRY_STUB_PATH = process.env.AUTODOC_SENTRY_STUB_PATH
const shouldAllowSentryInEnv =
  !!SENTRY_STUB_PATH || (!isE2E && (!is.dev || !!process.env.AUTODOC_SENTRY_DEV))
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
let mainSentry: MainSentryRuntimeModule | null = null
let mainSentryEnabled = false
let onMainSentryReady: (() => void) | null = null
let analyticsConsentEnabled = false
let diagnosticLogUploadConsentEnabled = false

function syncDiagnosticLogUploadForErrors(): void {
  setDiagnosticLogUploadForErrorsEnabled(
    analyticsConsentEnabled && diagnosticLogUploadConsentEnabled
  )
}

const gotSingleInstanceLock = app.requestSingleInstanceLock(buildSingleInstanceLaunchData())
traceInstallPolicy('index: single-instance lock result', {
  gotLock: gotSingleInstanceLock,
  execPath: process.execPath,
  pid: process.pid
})
const PENDING_RECOVERY_INTERVAL_MS = 2 * 60 * 1000
const WINDOWS_OLLAMA_SETUP_RETRY_DELAYS_MS =
  isTestRuntime && isRealSetupTest && process.env.AUTODOC_TEST_OLLAMA_SETUP_RETRY_DELAYS_MS
    ? process.env.AUTODOC_TEST_OLLAMA_SETUP_RETRY_DELAYS_MS.split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0)
    : [0, 5_000, 30_000, 120_000]
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
    '}'
  ].join('; ')

  spawn(
    'powershell',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      detached: true,
      stdio: 'ignore'
    }
  ).unref()
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

type MainSentryRuntimeModule = {
  init(options: Record<string, unknown>): void
  withScope(callback: (scope: unknown) => void): void
  captureException(error: Error): void
  captureMessage?: (message: string, level?: 'info' | 'warning' | 'error') => void
  setContext(key: string, data: Record<string, unknown>): void
  setTag(key: string, value: string): void
  getIsolationScope(): { clear(): void }
  getCurrentScope(): { clear(): void }
  getDefaultIntegrations?: (options: Record<string, unknown>) => Array<{ name: string }>
}

function initializeMainSentry(): void {
  if ((!SENTRY_DSN && !SENTRY_STUB_PATH) || !shouldAllowSentryInEnv || mainSentryEnabled) return

  try {
    if (!mainSentry) {
      if (SENTRY_STUB_PATH) {
        mainSentry = createSentryStubRuntime(SENTRY_STUB_PATH) as MainSentryRuntimeModule
      } else {
        mainSentry = require('@sentry/electron/main') as MainSentryRuntimeModule
      }
    }

    const sentryRuntime = mainSentry
    const scrubString = (input: string): string => input.replaceAll(homeDir, '[home]')
    const integrations =
      sentryRuntime.getDefaultIntegrations?.({ sendDefaultPii: false }).filter(
        (integration) => integration.name !== 'MainProcessSession'
      ) ?? []

    const initOptions = {
      dsn: SENTRY_DSN ?? 'stub://autodoc',
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
      }
    }

    sentryRuntime.init(initOptions)
    initSentryReporter(mainSentry as unknown as typeof import('@sentry/electron/main'))
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
    diagnosticLogUploadConsentEnabled = readInitialDiagnosticLogUploadConsent()
    syncDiagnosticLogUploadForErrors()
  } catch (err) {
    console.warn('Failed to read initial diagnostics consent for Sentry:', err)
  }

  initializeMainSentry()

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    void handleSecondInstanceLaunch(additionalData, argv)
      .then((handled) => {
        if (!handled) {
          focusMainWindow()
        }
      })
      .catch((error) => {
        console.warn('Failed to handle second AutoDoc launch:', error)
        focusMainWindow()
      })
  })
}

function createWindow(): void {
  recordMainDiagnosticAction({ category: 'app', action: 'main_window_created' })
  const windowIcon = is.dev
    ? join(
        __dirname,
        process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png'
      )
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
      sandbox: false
    }
  })

  registerMainWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Hide to tray instead of closing (unless user is quitting)
  mainWindow.on('close', (e) => {
    if (!isQuitting && !isE2E && !isRealSetupTest) {
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
  if (!skipInstalledApplicationPolicy && !(await enforceInstalledApplicationPolicy())) return

  const buildPermissionLogContext = (
    context?: Record<string, unknown>
  ): Record<string, unknown> => {
    const macBundleMetadata = getMacBundleMetadata()

    return {
      platform: process.platform,
      isPackaged: app.isPackaged,
      appName: app.getName(),
      appVersion: app.getVersion(),
      expectedAppId: EXPECTED_APP_ID,
      executablePath: app.getPath('exe'),
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      pid: process.pid,
      bundlePath: macBundleMetadata?.bundlePath ?? null,
      infoPlistPath: macBundleMetadata?.infoPlistPath ?? null,
      bundleIdentifier: macBundleMetadata?.bundleIdentifier ?? null,
      bundleName: macBundleMetadata?.bundleName ?? null,
      bundleDisplayName: macBundleMetadata?.bundleDisplayName ?? null,
      ...context
    }
  }

  const logPermissionEvent = (message: string, context?: Record<string, unknown>): void => {
    logAutodocEvent({
      area: 'app',
      message,
      context: buildPermissionLogContext(context)
    })
  }

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('diagnostics:record-action', (_event, payload) => {
    recordRendererDiagnosticAction(payload)

    if (
      payload.category === 'system' ||
      payload.category === 'onboarding' ||
      (payload.category === 'recording' && payload.action.startsWith('capture_recovery_'))
    ) {
      logAutodocEvent({
        area: payload.category === 'recording' ? 'recording' : 'app',
        message: `renderer_diagnostic:${payload.action}`,
        context: buildPermissionLogContext({
          category: payload.category,
          details: payload.details ?? null
        })
      })
    }
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
    nodeVersion: process.versions.node
  }
  let whisperContext: Record<string, unknown> = { ready: false, modelFilename: null }
  let ollamaContext: Record<string, unknown> = { ready: false, modelName: null }
  let calendarContext: Record<string, unknown> = {
    connected: false,
    providerCount: 0,
    accountCount: 0
  }

  const applyCurrentSentryContext = (): void => {
    setGlobalTag('platform', process.platform)
    setGlobalTag('arch', process.arch)
    setGlobalTag('app_version', app.getVersion())
    setGlobalTag('electron_version', process.versions.electron)
    setGlobalTag(
      'diagnostic_log_upload_consent',
      diagnosticLogUploadConsentEnabled ? 'enabled' : 'disabled'
    )
    setGlobalContext('runtime', runtimeContext)
    setGlobalContext('whisper', whisperContext)
    setGlobalContext('ollama', ollamaContext)
    setGlobalContext('calendar', calendarContext)
    setGlobalContext('privacy', {
      analyticsConsentEnabled,
      diagnosticLogUploadConsentEnabled
    })
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

  const isExperimentalSpeakerDiarizationEnabled = (): boolean => {
    // Speaker diarization is intentionally hard-disabled for now, so release
    // builds skip bundling the pyannote/lightning runtime until we re-enable it.
    return false
  }

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
      const permissions = getE2EPermissions()
      logPermissionEvent('permissions_check_e2e', permissions)
      return permissions
    }

    if (process.platform === 'darwin') {
      const microphoneStatus = systemPreferences.getMediaAccessStatus('microphone')
      const screenStatus = systemPreferences.getMediaAccessStatus('screen')
      const microphone = microphoneStatus === 'granted'
      const screen = screenStatus === 'granted'
      logPermissionEvent('permissions_check_completed', {
        microphoneStatus,
        screenStatus,
        microphoneGranted: microphone,
        screenGranted: screen
      })
      return { screen, microphone }
    }
    // On Windows/Linux, permissions are generally granted by default
    logPermissionEvent('permissions_check_non_darwin_default_granted')
    return { screen: true, microphone: true }
  })

  ipcMain.handle('permissions:request-microphone-access', async () => {
    if (isE2E) {
      const granted = requestE2EMicrophoneAccess()
      logPermissionEvent('microphone_access_request_e2e_completed', { granted })
      return granted
    }

    if (process.platform === 'darwin') {
      try {
        const preRequestStatus = systemPreferences.getMediaAccessStatus('microphone')
        logPermissionEvent('microphone_access_request_started', { preRequestStatus })
        const granted = await systemPreferences.askForMediaAccess('microphone')
        const postRequestStatus = systemPreferences.getMediaAccessStatus('microphone')
        logPermissionEvent('microphone_access_request_completed', {
          granted,
          preRequestStatus,
          postRequestStatus
        })
        return granted
      } catch (error) {
        console.warn('Failed to request macOS microphone access:', error)
        logAutodocFailure({
          area: 'app',
          message: 'microphone_access_request_failed',
          error,
          context: buildPermissionLogContext({
            preRequestStatus: systemPreferences.getMediaAccessStatus('microphone')
          })
        })
        return false
      }
    }

    logPermissionEvent('microphone_access_request_non_darwin_default_granted')
    return true
  })

  ipcMain.handle('permissions:open-settings', (_event, panel: 'screen' | 'microphone') => {
    if (isE2E) {
      logPermissionEvent('permissions_open_settings_e2e_skipped', { panel })
      return
    }

    if (process.platform === 'darwin') {
      const url =
        panel === 'screen'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
          : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      logPermissionEvent('permissions_open_settings_requested', { panel, url })
      if (panel === 'screen') {
        shell.openExternal(url)
      } else {
        shell.openExternal(url)
      }
    }
  })

  const calendarManager = new CalendarManager()
  registerCalendarIpc(
    calendarManager,
    (events) => {
      cachedEvents = events
      updateTrayMenu()
    },
    (connected) => {
      updateCalendarSentryContext({
        connected,
        providerCount: connected
          ? new Set(calendarManager.getAccounts().map((account) => account.provider)).size
          : 0,
        accountCount: calendarManager.getAccounts().length
      })
    }
  )

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
    const hasVideo = await stat(videoPath)
      .then(() => true)
      .catch(() => false)
    const hasMicAudio = await stat(micPath)
      .then(() => true)
      .catch(() => false)
    const hasSystemAudio = await stat(systemPath)
      .then(() => true)
      .catch(() => false)
    const hasLegacyAudio = await stat(legacyAudioPath)
      .then(() => true)
      .catch(() => false)
    const audioFile = hasSystemAudio
      ? 'system.webm'
      : hasMicAudio
        ? 'mic.webm'
        : hasLegacyAudio
          ? 'audio.webm'
          : undefined
    return {
      hasVideo,
      hasAudio: Boolean(audioFile),
      audioFile,
      mediaBaseUrl: recordingMediaBaseUrl ?? undefined
    }
  })

  ipcMain.handle(
    'recording:report-media-player-error',
    (_event, payload: RecordingMediaPlayerErrorReport) => {
      logAutodocFailure({
        area: 'recording',
        message: 'Renderer media element error (video/audio)',
        meetingId: payload.meetingId,
        context: { surface: 'renderer', ...payload }
      })
    }
  )

  const whisperManager = new WhisperManager()
  const localProcessingCoordinator = new LocalProcessingCoordinator(
    async () =>
      (await whisperManager.getEffectiveMacProcessingProfile())?.serializeLocalProcessing === true
  )
  const audioConverter = new AudioConverter()
  const diarizationService =
    isE2E || isExperimentalSpeakerDiarizationEnabled() ? new DiarizationService() : null
  const transcriptionService = new TranscriptionService(
    whisperManager,
    audioConverter,
    recordingService.getRecordingsBaseDir(),
    calendarManager,
    (meetingId) => {
      const state = recordingService.getState()
      return state.isRecording && state.meetingId === meetingId
    },
    diarizationService,
    isExperimentalSpeakerDiarizationEnabled,
    localProcessingCoordinator
  )
  ollamaManager = new OllamaManager()
  const managedOllamaManager = ollamaManager

  // Mutable state tracking Ollama setup progress
  const ollamaSetupState: OllamaSetupStatus = isE2E
    ? getE2EOllamaStatus()
    : { phase: 'starting', percent: 0 }
  let lastSuccessfulOllamaPhase: OllamaSetupStatus['phase'] = isE2E
    ? ollamaSetupState.phase
    : 'starting'

  function broadcastOllamaStatus(): void {
    updateOllamaSentryContext({
      ready: ollamaSetupState.phase === 'ready',
      modelName: managedOllamaManager.getModel(),
      phase: ollamaSetupState.phase,
      failedStep: ollamaSetupState.failedStep ?? null
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
    lastSuccessfulOllamaPhase = 'downloading'
    ollamaSetupState.phase = 'downloading'
    ollamaSetupState.percent = 100
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

  const markOllamaSetupStarting = (): void => {
    lastSuccessfulOllamaPhase = 'starting'
    ollamaSetupState.phase = 'starting'
    ollamaSetupState.percent = 0
    delete ollamaSetupState.error
    delete ollamaSetupState.failedStep
    broadcastOllamaStatus()
  }

  const markOllamaSetupFailed = (err: unknown): void => {
    ollamaSetupState.phase = 'error'
    ollamaSetupState.percent = 0
    ollamaSetupState.error = err instanceof Error ? err.message : String(err)
    ollamaSetupState.failedStep =
      lastSuccessfulOllamaPhase === 'error' ? 'starting' : lastSuccessfulOllamaPhase
    broadcastOllamaStatus()
    logAutodocFailure({
      area: 'ollama',
      message: 'Failed to start managed Ollama server',
      error: err
    })
    console.error('Failed to start Ollama:', err)
  }

  const windowsOllamaSetupCoordinator =
    process.platform === 'win32'
      ? new OllamaSetupCoordinator(managedOllamaManager, {
          retryDelaysMs: WINDOWS_OLLAMA_SETUP_RETRY_DELAYS_MS,
          onAttemptStart: markOllamaSetupStarting,
          onFinalError: markOllamaSetupFailed
        })
      : null

  let ollamaRecoveryPromise: Promise<void> | null = null

  // `force` is honored only by the Windows setup coordinator; the non-Windows
  // path keeps its existing single recovery flow unchanged.
  const ensureOllamaRunning = (options: { force?: boolean } = {}): void => {
    if (windowsOllamaSetupCoordinator) {
      void windowsOllamaSetupCoordinator.ensureRunning(options).catch(() => {})
      return
    }

    if (ollamaRecoveryPromise) return

    managedOllamaManager.resetReady()
    markOllamaSetupStarting()

    ollamaRecoveryPromise = managedOllamaManager
      .startAndPull()
      .then(() => {
        lastSuccessfulOllamaPhase = 'ready'
        ollamaSetupState.phase = 'ready'
        ollamaSetupState.percent = 100
        delete ollamaSetupState.error
        delete ollamaSetupState.failedStep
        broadcastOllamaStatus()
      })
      .catch((err) => {
        markOllamaSetupFailed(err)
      })
      .finally(() => {
        ollamaRecoveryPromise = null
      })
  }

  const broadcastSegmentationDiagnostic = (payload: SegmentationDiagnosticPayload): void => {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('segmentation:diagnostic-event', payload)
    }
  }

  const ollamaProvider = new OllamaProvider(
    managedOllamaManager.getBaseUrl(),
    managedOllamaManager.getModel(),
    { onTelemetry: broadcastSegmentationDiagnostic }
  )
  const ollamaReadiness = windowsOllamaSetupCoordinator ?? managedOllamaManager
  const ollamaRuntime = {
    waitUntilReady: () => ollamaReadiness.waitUntilReady(),
    isServerRunning: () => managedOllamaManager.isServerRunning(),
    getBaseUrl: () => managedOllamaManager.getBaseUrl()
  }
  const segmentationService = new SegmentationService(
    ollamaProvider,
    ollamaReadiness,
    recordingService.getRecordingsBaseDir(),
    localProcessingCoordinator,
    () => whisperManager.getMacProcessingProfile(),
    () => whisperManager.getEffectiveMacProcessingProfile()
  )
  ipcMain.handle(
    'app:get-runtime-info',
    (): AppRuntimeInfo => ({
      platform: isE2E ? getE2EPlatform() : process.platform,
      storagePath: app.getPath('userData'),
      whisperModel: whisperManager.getModelName(),
      transcriptionBackend: whisperManager.getTranscriptionBackend(),
      ollamaModel: managedOllamaManager.getModel()
    })
  )
  ipcMain.handle('app:get-storage-info', async (): Promise<AppStorageInfo> => {
    return await getAppStorageInfo()
  })
  ipcMain.handle('app:clear-downloaded-components', async (): Promise<AppStorageInfo> => {
    logAutodocEvent({
      area: 'app',
      message: 'app:clear-downloaded-components requested',
      context: {
        diagnostics: await getStorageDiagnostics({
          whisperBinaryPath: whisperManager.getWhisperPath(),
          ffmpegPath: whisperManager.getFfmpegPath(),
          whisperModelPath: whisperManager.getModelPath()
        })
      }
    })
    managedOllamaManager.stop()
    managedOllamaManager.resetReady()
    await clearDownloadedComponents()
    logAutodocEvent({
      area: 'app',
      message: 'app:clear-downloaded-components completed',
      context: {
        diagnostics: await getStorageDiagnostics({
          whisperBinaryPath: whisperManager.getWhisperPath(),
          ffmpegPath: whisperManager.getFfmpegPath(),
          whisperModelPath: whisperManager.getModelPath()
        })
      }
    })
    return await getAppStorageInfo()
  })
  ipcMain.handle('app:reset-local-data', (): void => {
    if (recordingService.getState().isRecording) {
      throw new Error('Stop the current recording before deleting local AutoDoc data.')
    }

    managedOllamaManager.stop()
    managedOllamaManager.resetReady()

    void getStorageDiagnostics({
      whisperBinaryPath: whisperManager.getWhisperPath(),
      ffmpegPath: whisperManager.getFfmpegPath(),
      whisperModelPath: whisperManager.getModelPath()
    })
      .then((diagnostics) => {
        logAutodocEvent({
          area: 'app',
          message: 'app:reset-local-data requested',
          context: {
            diagnostics,
            testUserDataDir: testUserDataDir ?? null,
            isE2E,
            isRealSetupTest
          }
        })
      })
      .catch(() => {})

    if (process.platform === 'win32' && isE2E && testUserDataDir) {
      const userDataPath = app.getPath('userData')
      const targetPaths = getResetLocalDataTargets({
        userDataPath,
        appDataPath: app.getPath('appData'),
        testUserDataDir,
        isE2E,
        isRealSetupTest
      })
      // In Windows-hosted E2E runs, deleting the temp profile after process exit
      // avoids relaunching an unmanaged second app instance that Playwright can't own.
      clearWindowsE2ETestUserDataContents(userDataPath)
      scheduleWindowsE2ETestResetCleanup(targetPaths)
      setTimeout(() => app.exit(0), 100)
      return
    }

    const relaunchArgs = process.argv.slice(1).filter((arg) => arg !== RESET_LOCAL_DATA_ARG)

    app.relaunch({ args: [...relaunchArgs, RESET_LOCAL_DATA_ARG] })
    setTimeout(() => app.exit(0), 100)
  })
  let pendingRecoveryPromise: Promise<unknown> | null = null

  const recoverPendingWork = (): void => {
    if (pendingRecoveryPromise) return

    pendingRecoveryPromise = Promise.all([
      transcriptionService.scanAndEnqueuePending(),
      segmentationService.scanAndEnqueuePending()
    ])
      .catch((err) => {
        logAutodocFailure({
          area: 'app',
          message: 'Pending meeting recovery failed',
          error: err
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
  const pendingReprocessNotificationMeetingIds = new Set<string>()
  const markReprocessNotificationPending = (meetingId: string): void => {
    pendingReprocessNotificationMeetingIds.add(meetingId)
  }
  segmentationService.onComplete((meetingId) => {
    const allowRepeat = pendingReprocessNotificationMeetingIds.has(meetingId)
    void notifyNotesReady(recordingService.getRecordingsBaseDir(), meetingId, { allowRepeat })
      .catch((err) => {
        logAutodocFailure({
          area: 'segmentation',
          message: 'Failed to show notes ready notification',
          error: err,
          meetingId
        })
      })
      .finally(() => {
        if (allowRepeat) {
          pendingReprocessNotificationMeetingIds.delete(meetingId)
        }
      })
  })

  let cachedEvents: import('../shared/types').CalendarEvent[] = []

  const detectionService = new DetectionService(recordingService, () => cachedEvents)

  ipcMain.handle('detection:dismiss', () => {
    detectionService.dismissPrompt()
  })

  const whisperEngineSetupState: WhisperSetupStatus = { phase: 'checking', percent: 0 }
  const isSpeakerDiarizationSetupEnabled = (): boolean =>
    isE2E || isExperimentalSpeakerDiarizationEnabled()
  const diarizationSetupState: DiarizationSetupStatus = isSpeakerDiarizationSetupEnabled()
    ? isE2E
      ? { phase: 'ready', percent: 100 }
      : { phase: 'checking', percent: 0 }
    : { phase: 'ready', percent: 100 }
  let lastSuccessfulWhisperPhase: WhisperSetupStatus['phase'] = 'checking'
  let lastSuccessfulDiarizationPhase: DiarizationSetupStatus['phase'] =
    isSpeakerDiarizationSetupEnabled() ? (isE2E ? 'ready' : 'checking') : 'ready'
  const getWhisperFailedStep = (): WhisperSetupStatus['failedStep'] =>
    lastSuccessfulWhisperPhase === 'downloading-ffmpeg' ||
    lastSuccessfulWhisperPhase === 'downloading-model' ||
    lastSuccessfulWhisperPhase === 'ready'
      ? lastSuccessfulWhisperPhase
      : 'downloading-whisper'

  const getDiarizationFailedStep = (): DiarizationSetupStatus['failedStep'] =>
    lastSuccessfulDiarizationPhase === 'installing-speaker-id' ||
    lastSuccessfulDiarizationPhase === 'downloading-speaker-model' ||
    lastSuccessfulDiarizationPhase === 'ready'
      ? lastSuccessfulDiarizationPhase
      : 'preparing-speaker-runtime'

  const mapDiarizationToTranscriptionStatus = (
    status: DiarizationSetupStatus,
    whisperStatus: WhisperSetupStatus
  ): WhisperSetupStatus => ({
    phase: status.phase,
    percent: status.percent,
    error: status.error,
    backend: whisperStatus.backend,
    backendLabel: whisperStatus.backendLabel,
    failedStep: status.failedStep
  })

  const getCurrentWhisperEngineSetupStatus = (): WhisperSetupStatus => {
    if (isE2E) {
      return { ...whisperEngineSetupState }
    }

    const status = whisperManager.getSetupStatus()
    if (status.phase === 'error') {
      return {
        ...status,
        failedStep: status.failedStep ?? getWhisperFailedStep()
      }
    }

    return { ...status }
  }

  const getCurrentDiarizationSetupStatus = (): DiarizationSetupStatus => {
    if (!isSpeakerDiarizationSetupEnabled()) {
      return { phase: 'ready', percent: 100 }
    }

    const status = { ...diarizationSetupState }
    if (status.phase === 'error') {
      return {
        ...status,
        failedStep: status.failedStep ?? getDiarizationFailedStep()
      }
    }

    return { ...status }
  }

  const getCombinedTranscriptionSetupStatus = (): WhisperSetupStatus => {
    const whisperStatus = getCurrentWhisperEngineSetupStatus()
    if (whisperStatus.phase === 'error') {
      return whisperStatus
    }
    if (whisperStatus.phase !== 'ready') {
      return whisperStatus
    }
    if (!isSpeakerDiarizationSetupEnabled()) {
      return { ...whisperStatus, phase: 'ready', percent: 100 }
    }

    const diarizationAsTranscription = mapDiarizationToTranscriptionStatus(
      getCurrentDiarizationSetupStatus(),
      whisperStatus
    )
    if (
      diarizationAsTranscription.phase === 'error' ||
      diarizationAsTranscription.phase !== 'ready'
    ) {
      return diarizationAsTranscription
    }

    return { ...whisperStatus, phase: 'ready', percent: 100 }
  }

  const broadcastTranscriptionSetupStatus = (): void => {
    const combined = getCombinedTranscriptionSetupStatus()
    updateWhisperSentryContext({
      ready: combined.phase === 'ready',
      modelFilename: whisperManager.getModelInfo().filename,
      whisperVersion: 'v1.8.4',
      phase: combined.phase,
      failedStep: combined.failedStep ?? null,
      diarizationPhase: diarizationSetupState.phase,
      diarizationFailedStep: diarizationSetupState.failedStep ?? null
    })
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.webContents.send('whisper:setup-progress', combined)
    }
  }

  whisperManager.on('setup-status', (status: WhisperSetupStatus) => {
    if (status.phase !== 'error') {
      lastSuccessfulWhisperPhase = status.phase
    }
    whisperEngineSetupState.phase = status.phase
    whisperEngineSetupState.percent = status.percent
    whisperEngineSetupState.error = status.error
    whisperEngineSetupState.backend = status.backend
    whisperEngineSetupState.backendLabel = status.backendLabel
    whisperEngineSetupState.failedStep =
      status.phase === 'error' ? getWhisperFailedStep() : undefined
    broadcastTranscriptionSetupStatus()
  })

  diarizationService?.on('setup-status', (status: DiarizationSetupStatus) => {
    if (!isSpeakerDiarizationSetupEnabled()) {
      return
    }
    if (status.phase !== 'error') {
      lastSuccessfulDiarizationPhase = status.phase
    }
    diarizationSetupState.phase = status.phase
    diarizationSetupState.percent = status.percent
    diarizationSetupState.error = status.error
    diarizationSetupState.failedStep =
      status.phase === 'error' ? getDiarizationFailedStep() : undefined
    broadcastTranscriptionSetupStatus()
  })

  const startDiarizationSetup = async (): Promise<void> => {
    if (!isSpeakerDiarizationSetupEnabled() || !diarizationService) {
      lastSuccessfulDiarizationPhase = 'ready'
      diarizationSetupState.phase = 'ready'
      diarizationSetupState.percent = 100
      delete diarizationSetupState.error
      delete diarizationSetupState.failedStep
      broadcastTranscriptionSetupStatus()
      return
    }
    await diarizationService.startSetup()
  }

  if (isE2E) {
    ipcMain.handle('e2e:set-whisper-status', (_event, status: WhisperSetupStatus) => {
      const nextStatus = setE2EWhisperStatus(status)
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('whisper:setup-progress', nextStatus)
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

    ipcMain.handle('e2e:get-detection-state', () => {
      return getE2EDetectionState()
    })

    ipcMain.handle('e2e:get-permission-request-state', () => {
      return getE2EPermissionRequestState()
    })

    ipcMain.handle('e2e:set-detection-state', (_event, state: Partial<E2EDetectionState>) => {
      return setE2EDetectionState(state)
    })

    ipcMain.handle('e2e:detection-poll', async (_event, advanceMs?: number) => {
      await detectionService.debugPollNow(advanceMs ?? 0)
    })

    ipcMain.handle('e2e:trigger-main-error', async () => {
      logAutodocFailure({
        area: 'app',
        message: 'E2E controlled failure',
        error: new Error('E2E controlled failure'),
        context: {
          sourceName: 'Quarterly Planning with jane@example.com',
          trackedSourceName: 'Zoom Meeting - Product Review',
          relevantWindowNames: ['Zoom Meeting - Product Review', 'Slack | Team Channel'],
          access_token: 'secret-token-value',
          path: '/Users/tester/Documents/meeting-notes.txt'
        }
      })
      await flushAutodocLogWrites()
    })

    ipcMain.handle(
      'e2e:trigger-notes-ready-notification',
      async (
        _event,
        options?: {
          meetingId?: string
          title?: string
          status?: 'complete' | 'failed'
          allowRepeat?: boolean
        }
      ) => {
        const meetingId = options?.meetingId ?? `e2e-notes-ready-${Date.now()}`
        const meetingDir = join(recordingService.getRecordingsBaseDir(), meetingId)
        const existingMetadata = await readMetadata(meetingDir)
        if (!existingMetadata) {
          await mkdir(meetingDir, { recursive: true })
          await encryptJSON(
            {
              sourceName: options?.title ?? 'Weekly Sync',
              startedAt: Date.now() - 60_000,
              stoppedAt: Date.now(),
              durationSeconds: 60
            },
            join(meetingDir, 'metadata.json')
          )
          await encryptJSON(
            [
              {
                id: `${meetingId}-transcript-1`,
                meetingId,
                speaker: 'Speaker 1',
                text: 'AutoDoc finished the transcript and notes.',
                startMs: 0,
                endMs: 5_000,
                confidence: 0.99
              }
            ],
            join(meetingDir, 'transcript.json')
          )
          if (options?.status === 'failed') {
            await writeFile(
              join(meetingDir, 'segments.error'),
              JSON.stringify({
                error: 'E2E segmentation failure',
                retries: 1,
                status: 'failed'
              }),
              'utf-8'
            )
          } else {
            await encryptJSON(
              {
                decisions: [],
                actionItems: [],
                information: [
                  {
                    id: `${meetingId}-segment-1`,
                    meetingId,
                    category: 'information',
                    topic: 'Follow-up',
                    title: 'Summary ready',
                    content: 'The transcript and notes are ready to review.',
                    assignee: null,
                    deadline: null,
                    sourceStartMs: 0,
                    sourceEndMs: 5_000
                  }
                ],
                discussion: [],
                statusUpdates: []
              },
              join(meetingDir, 'segments.json')
            )
          }
        }

        if (options?.status !== 'failed') {
          await notifyNotesReady(recordingService.getRecordingsBaseDir(), meetingId, {
            allowRepeat: options?.allowRepeat
          })
        }
        return meetingId
      }
    )
  }

  if (isRealSetupTest) {
    ipcMain.handle('e2e:install-bundled-mac-whisper-runtime', async () => {
      await whisperManager.installBundledMacWhisperRuntimeOnly()
      return {
        storagePath: app.getPath('userData'),
        whisperPath: whisperManager.getWhisperPath(),
        modelsDir: whisperManager.getModelsDir()
      }
    })
  }

  const { stopActiveRecording } = registerRecordingIpc(
    recordingService,
    transcriptionService,
    whisperManager,
    calendarManager
  )
  registerTranscriptionIpc(transcriptionService, markReprocessNotificationPending)
  registerLlmIpc(
    segmentationService,
    managedOllamaManager,
    ollamaProvider,
    () => ({ ...ollamaSetupState }),
    ensureOllamaRunning,
    !windowsOllamaSetupCoordinator,
    markReprocessNotificationPending
  )
  registerWhisperIpc(
    whisperManager,
    () => getCombinedTranscriptionSetupStatus(),
    async () => {
      await Promise.allSettled([whisperManager.startSetup(), startDiarizationSetup()])
    }
  )
  registerSearchIpc(recordingService.getRecordingsBaseDir())
  registerChatIpc(
    recordingService.getRecordingsBaseDir(),
    ollamaRuntime,
    ollamaProvider,
    calendarManager
  )
  registerSpeakersIpc(recordingService.getRecordingsBaseDir())

  const restoredAccounts = await calendarManager.initialize()
  updateCalendarSentryContext({
    connected: restoredAccounts.length > 0,
    providerCount: new Set(restoredAccounts.map((account) => account.provider)).size,
    accountCount: restoredAccounts.length
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
      error: err
    })
    console.error('Data dir migration failed:', err)
  }

  try {
    await initializeEncryption(recordingService.getRecordingsBaseDir())
  } catch (err) {
    logAutodocFailure({
      area: 'app',
      message: 'Encryption key initialization failed',
      error: err
    })
    console.error('Encryption key initialization failed:', err)
  }

  try {
    await migrateRecordings(recordingService.getRecordingsBaseDir())
  } catch (err) {
    logAutodocFailure({
      area: 'app',
      message: 'Encryption migration failed',
      error: err
    })
    console.error('Encryption migration failed:', err)
  }

  registerPrefsIpc(
    prefsStore,
    (enabled) => {
      analyticsConsentEnabled = enabled
      syncDiagnosticLogUploadForErrors()
      if (mainSentryEnabled) {
        resetSentryScopes()
        applyCurrentSentryContext()
      }
    },
    (enabled) => {
      diagnosticLogUploadConsentEnabled = enabled
      syncDiagnosticLogUploadForErrors()
      if (mainSentryEnabled) {
        applyCurrentSentryContext()
      }
    },
    (enabled) => {
      if (!enabled) {
        lastSuccessfulDiarizationPhase = 'ready'
        diarizationSetupState.phase = 'ready'
        diarizationSetupState.percent = 100
        delete diarizationSetupState.error
        delete diarizationSetupState.failedStep
        broadcastTranscriptionSetupStatus()
        return
      }

      lastSuccessfulDiarizationPhase = 'checking'
      diarizationSetupState.phase = 'checking'
      diarizationSetupState.percent = 0
      delete diarizationSetupState.error
      delete diarizationSetupState.failedStep
      broadcastTranscriptionSetupStatus()

      startDiarizationSetup().catch((err) => {
        diarizationSetupState.phase = 'error'
        diarizationSetupState.error = err instanceof Error ? err.message : String(err)
        diarizationSetupState.failedStep = getDiarizationFailedStep()
        broadcastTranscriptionSetupStatus()
        logAutodocFailure({
          area: 'diarization',
          message: 'Failed to set up speaker diarization after enabling the experimental feature',
          error: err
        })
        console.error('Failed to set up speaker diarization after enabling experimental mode:', err)
      })
    }
  )

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
        }
      })
    }

    recoverPendingWork()
    if (!isRealSetupTest) {
      detectionService.start()
    }

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
    if (shouldSuppressNotificationActivation()) {
      return
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
    error
  })
  console.error('Uncaught exception in main process:', error)
})

process.on('unhandledRejection', (reason) => {
  logAutodocFailure({
    area: 'app',
    message: 'Unhandled rejection in main process',
    error: reason
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
  logAutodocEvent({
    area: 'app',
    message: 'legacy data migration started',
    context: {
      legacyBase,
      newBase,
      subdirs
    }
  })

  for (const subdir of subdirs) {
    const src = join(legacyBase, subdir)
    const dest = join(newBase, subdir)
    try {
      await access(src)
    } catch {
      continue // Subdir doesn't exist in legacy location
    }
    logAutodocEvent({
      area: 'app',
      message: 'legacy data migration inspecting subdir',
      context: {
        subdir,
        src,
        dest
      }
    })
    try {
      await access(dest)
      // Dest already exists — merge by moving individual entries
      const entries = await readdir(src)
      const movedEntries: string[] = []
      const skippedEntries: string[] = []
      for (const entry of entries) {
        const entrySrc = join(src, entry)
        const entryDest = join(dest, entry)
        try {
          await access(entryDest)
          // Already exists at dest, skip
          skippedEntries.push(entry)
        } catch {
          await rename(entrySrc, entryDest)
          movedEntries.push(entry)
        }
      }
      // Remove legacy subdir if now empty
      const remaining = await readdir(src)
      if (remaining.length === 0) await rmdir(src)
      logAutodocEvent({
        area: 'app',
        message: 'legacy data migration merged subdir entries',
        context: {
          subdir,
          src,
          dest,
          movedEntries,
          skippedEntries,
          remainingEntries: remaining
        }
      })
    } catch {
      // Dest doesn't exist — simple rename
      await mkdir(newBase, { recursive: true })
      await rename(src, dest)
      logAutodocEvent({
        area: 'app',
        message: 'legacy data migration moved whole subdir',
        context: {
          subdir,
          src,
          dest
        }
      })
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
