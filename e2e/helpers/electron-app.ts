import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { expect, type Page, _electron as electron } from '@playwright/test'
import type { E2EDetectionState, E2EScenario } from '../../src/shared/e2e'
import type { OllamaSetupStatus, WhisperSetupStatus } from '../../src/shared/types'

function resolveMainEntry(appRoot: string): string {
  return path.join(appRoot, 'out', 'main', 'index.js')
}

async function launchApp(options: {
  appRoot?: string
  extraEnv?: Record<string, string>
  scenario?: E2EScenario
  userDataDir?: string
  realSetup?: boolean
}) {
  const appRoot = options.appRoot ?? process.cwd()
  const mainEntry = resolveMainEntry(appRoot)
  expect(existsSync(mainEntry)).toBeTruthy()

  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AUTODOC_TEST_MODE: '1',
      ...(options.realSetup ? { AUTODOC_TEST_REAL_SETUP: '1' } : { AUTODOC_E2E: '1' }),
      ...(options.scenario ? { AUTODOC_E2E_SCENARIO: JSON.stringify(options.scenario) } : {}),
      ...(options.userDataDir ? { AUTODOC_TEST_USER_DATA_DIR: options.userDataDir } : {}),
      ...(options.extraEnv ?? {})
    }
  })
}

export async function launchE2EApp(scenario?: E2EScenario) {
  return await launchApp({ scenario })
}

export async function launchExternalE2EApp(appRoot: string, scenario?: E2EScenario) {
  return await launchApp({ appRoot, scenario })
}

function killProcessesForUserDataDir(userDataDir: string): void {
  const terminatePid = (pid: number): void => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }

    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited after SIGTERM.
    }
  }

  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$path = ${JSON.stringify(userDataDir)}; ` +
            'Get-CimInstance Win32_Process -Filter "Name = \'autodoc.exe\'" | ' +
            "Where-Object { $_.CommandLine -like ('*' + $path + '*') } | " +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        ],
        { stdio: 'ignore' }
      )
      return
    }

    const output = execFileSync('ps', ['eww', '-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    for (const pid of output
      .split(/\r?\n/)
      .filter((line) => line.includes(userDataDir))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter(Boolean)) {
      terminatePid(pid)
    }
  } catch {}
}

export async function launchIsolatedE2EApp(scenario?: E2EScenario) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-e2e-isolated-'))
  const electronApp = await launchApp({ scenario, userDataDir })

  return {
    electronApp,
    userDataDir,
    async cleanup(): Promise<void> {
      try {
        await electronApp.close()
      } finally {
        killProcessesForUserDataDir(userDataDir)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  }
}

export async function launchIsolatedExternalE2EApp(appRoot: string, scenario?: E2EScenario) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-e2e-isolated-'))
  const electronApp = await launchApp({ appRoot, scenario, userDataDir })

  return {
    electronApp,
    userDataDir,
    async cleanup(): Promise<void> {
      try {
        await electronApp.close()
      } finally {
        killProcessesForUserDataDir(userDataDir)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  }
}

export async function launchRealSetupApp(
  extraEnv?: Record<string, string>,
  options: { userDataDir?: string; cleanupUserDataDir?: boolean } = {}
) {
  const userDataDir =
    options.userDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'autodoc-real-setup-'))
  const cleanupUserDataDir = options.cleanupUserDataDir ?? !options.userDataDir
  const electronApp = await launchApp({ realSetup: true, userDataDir, extraEnv })

  return {
    electronApp,
    userDataDir,
    async cleanup(): Promise<void> {
      try {
        await electronApp.close()
      } finally {
        killProcessesForUserDataDir(userDataDir)
        if (cleanupUserDataDir) {
          rmSync(userDataDir, { recursive: true, force: true })
        }
      }
    }
  }
}

export async function stubMediaCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {}
      })
    }

    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('E2E media capture is stubbed')
    }
  })
}

export async function setWhisperStatus(page: Page, status: WhisperSetupStatus): Promise<void> {
  await page.evaluate(async (nextStatus) => {
    await window.electronAPI.invoke('e2e:set-whisper-status', nextStatus)
  }, status)
}

export async function setOllamaStatus(page: Page, status: OllamaSetupStatus): Promise<void> {
  await page.evaluate(async (nextStatus) => {
    await window.electronAPI.invoke('e2e:set-ollama-status', nextStatus)
  }, status)
}

export async function getDetectionState(page: Page): Promise<E2EDetectionState> {
  return await page.evaluate(async () => {
    return await window.electronAPI.invoke('e2e:get-detection-state')
  })
}

export async function setDetectionState(
  page: Page,
  state: Partial<E2EDetectionState>
): Promise<E2EDetectionState> {
  return await page.evaluate(async (nextState) => {
    return await window.electronAPI.invoke('e2e:set-detection-state', nextState)
  }, state)
}

export async function pollDetection(page: Page, advanceMs = 0): Promise<void> {
  await page.evaluate(async (nextAdvanceMs) => {
    await window.electronAPI.invoke('e2e:detection-poll', nextAdvanceMs)
  }, advanceMs)
}

export async function installFakeCaptureDevices(page: Page): Promise<void> {
  await page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaCaptureRequests: unknown[]
      __qaSwitchDefaultMic: () => void
      __qaAudioContexts: AudioContext[]
    }
    qaWindow.__qaCaptureRequests = []
    qaWindow.__qaAudioContexts = []

    let micVersion = 1
    const listeners = new Set<EventListenerOrEventListenerObject>()

    const makeVideoStream = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const context = canvas.getContext('2d')
      context!.fillStyle = '#4A6B4E'
      context!.fillRect(0, 0, canvas.width, canvas.height)
      context!.fillStyle = '#ffffff'
      context!.fillRect(16, 16, 48, 24)
      return canvas.captureStream(5)
    }

    const makeAudioStream = () => {
      const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext
      const audioContext = new AudioContextCtor()
      qaWindow.__qaAudioContexts.push(audioContext)
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.value = 440
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(destination)
      oscillator.start()
      void audioContext.resume().catch(() => {})
      return destination.stream
    }

    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices
    })

    mediaDevices.getUserMedia = async (constraints) => {
      qaWindow.__qaCaptureRequests.push(constraints)
      const wantsVideo = Boolean((constraints as MediaStreamConstraints).video)
      const wantsAudio = Boolean((constraints as MediaStreamConstraints).audio)
      const tracks: MediaStreamTrack[] = []

      if (wantsVideo) {
        tracks.push(...makeVideoStream().getVideoTracks())
      }
      if (wantsAudio) {
        tracks.push(...makeAudioStream().getAudioTracks())
      }

      return new MediaStream(tracks)
    }
    mediaDevices.enumerateDevices = async () =>
      [
        {
          kind: 'audioinput',
          deviceId: 'default',
          groupId: `mic-${micVersion}`,
          label: `Default Microphone ${micVersion}`
        },
        {
          kind: 'audiooutput',
          deviceId: 'default',
          groupId: 'speaker-1',
          label: 'Default Speaker'
        }
      ] as MediaDeviceInfo[]
    mediaDevices.addEventListener = (_type, listener) => {
      listeners.add(listener)
    }
    mediaDevices.removeEventListener = (_type, listener) => {
      listeners.delete(listener)
    }

    qaWindow.__qaSwitchDefaultMic = () => {
      micVersion += 1
      const event = new Event('devicechange')
      for (const listener of listeners) {
        if (typeof listener === 'function') {
          listener(event)
        } else {
          listener.handleEvent(event)
        }
      }
    }

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true
      }

      state: RecordingState = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        super()
      }

      start() {
        this.state = 'recording'
      }

      requestData() {
        this.ondataavailable?.({ data: new Blob(['qa'], { type: 'video/webm' }) })
      }

      stop() {
        this.state = 'inactive'
        this.dispatchEvent(new Event('stop'))
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder
    })
  })
}

export async function jumpToOnboardingStep(page: Page, step: number): Promise<void> {
  await page.evaluate(async (nextStep) => {
    await window.electronAPI.invoke('prefs:set-onboarding-step', nextStep)
  }, step)
  await page.reload()
}

export async function completeOnboarding(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electronAPI.invoke('prefs:set-onboarding-complete')
  })
  await page.reload()
}
