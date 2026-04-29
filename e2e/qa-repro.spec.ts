import { expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { E2EScenario } from '../src/shared/e2e'
import type { WhisperSetupStatus } from '../src/shared/types'
import {
  completeOnboarding,
  launchIsolatedE2EApp,
  setOllamaStatus,
  setWhisperStatus,
  stubMediaCapture
} from './helpers/electron-app'

interface ReproNote {
  issue: string
  reproduced: boolean | 'partial' | 'not-verifiable'
  evidence: string[]
  limitation?: string
}

async function attachReproNote(testInfo: TestInfo, note: ReproNote): Promise<void> {
  console.info(`[qa-repro] ${JSON.stringify(note)}`)
  await testInfo.attach(`${note.issue}-repro-note`, {
    body: JSON.stringify(note, null, 2),
    contentType: 'application/json'
  })
}

async function launchQaApp(scenario?: E2EScenario) {
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: {
      microphone: false,
      screen: false,
      ...scenario?.permissions
    },
    ...scenario
  })
  const page = await app.electronApp.firstWindow()
  return { app, page }
}

async function setWindowSize(
  electronApp: ElectronApplication,
  page: Page,
  width: number,
  height: number
): Promise<void> {
  const browserWindow = await electronApp.browserWindow(page)
  await browserWindow.evaluate(
    (win, size) => {
      win.setMinimumSize(240, 200)
      win.setSize(size.width, size.height)
    },
    { width, height }
  )
  await page.waitForTimeout(250)
}

async function advanceFeatureSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: /get started/i }).click()
  await expect(page.getByRole('heading', { name: 'Private by Design' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'Notes That Think' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
}

async function reachMicStep(page: Page): Promise<void> {
  await advanceFeatureSteps(page)
  await expect(page.getByRole('heading', { name: 'Microphone Access' })).toBeVisible()
}

async function completePermissionStepsAsDenied(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Microphone Access' })).toBeVisible()
  await stubMediaCapture(page)
  await page.getByRole('button', { name: /enable microphone/i }).click()
  await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
  await page.getByRole('button', { name: /^continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Screen Recording' })).toBeVisible()
  await page.getByRole('button', { name: /enable screen recording/i }).click()
  await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
  await page.getByRole('button', { name: /^continue/i }).click()
}

async function reachCalendarStep(page: Page): Promise<void> {
  await advanceFeatureSteps(page)
  await completePermissionStepsAsDenied(page)
  await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
}

async function reachTranscriptionStep(page: Page): Promise<void> {
  await reachCalendarStep(page)
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
}

async function visibleText(page: Page, pattern: RegExp): Promise<boolean> {
  return await page
    .getByText(pattern)
    .first()
    .isVisible()
    .catch(() => false)
}

async function clickBack(page: Page): Promise<string | null> {
  await page.getByRole('button', { name: /back/i }).click()
  await page.waitForTimeout(150)
  return await page.locator('h2').first().textContent()
}

test.describe('QA Linear repro pass', () => {
  test('AD-69 keeps onboarding step tracker clear of content at very small window sizes', async ({}, testInfo) => {
    const { app, page } = await launchQaApp()

    try {
      await page.getByRole('button', { name: /get started/i }).click()
      await expect(page.getByRole('heading', { name: 'Private by Design' })).toBeVisible()

      const sizes = [
        { width: 360, height: 320 },
        { width: 320, height: 260 },
        { width: 280, height: 220 }
      ]
      const evidence: string[] = []
      let reproduced = false

      for (const size of sizes) {
        await setWindowSize(app.electronApp, page, size.width, size.height)
        const measurement = await page.evaluate(() => {
          const dot = document.querySelector('[data-testid="step-dot"]')
          const icon = Array.from(document.querySelectorAll('div')).find(
            (candidate) =>
              candidate.textContent?.trim() === '🔒' &&
              candidate.className.toString().includes('w-16')
          )
          if (!dot || !icon) return null
          const dotBox = dot.parentElement?.getBoundingClientRect()
          const iconBox = icon.getBoundingClientRect()
          if (!dotBox) return null
          const verticalOverlap = dotBox.bottom > iconBox.top && dotBox.top < iconBox.bottom
          const horizontalOverlap = dotBox.right > iconBox.left && dotBox.left < iconBox.right
          return {
            dotBox: {
              top: Math.round(dotBox.top),
              bottom: Math.round(dotBox.bottom),
              left: Math.round(dotBox.left),
              right: Math.round(dotBox.right)
            },
            iconBox: {
              top: Math.round(iconBox.top),
              bottom: Math.round(iconBox.bottom),
              left: Math.round(iconBox.left),
              right: Math.round(iconBox.right)
            },
            overlaps: verticalOverlap && horizontalOverlap
          }
        })

        evidence.push(`${size.width}x${size.height}: ${JSON.stringify(measurement)}`)
        if (measurement?.overlaps) {
          reproduced = true
          await testInfo.attach('AD-69-overlap-screenshot', {
            body: await page.screenshot(),
            contentType: 'image/png'
          })
          break
        }
      }

      await attachReproNote(testInfo, {
        issue: 'AD-69',
        reproduced,
        evidence
      })
      expect(reproduced, evidence.join('\n')).toBe(false)
    } finally {
      await app.cleanup()
    }
  })

  test('AD-59 checks whether onboarding Back returns to the previous persisted step', async ({}, testInfo) => {
    const evidence: string[] = []
    let reproduced = false

    try {
      const standardFlow = await launchQaApp()

      try {
        await advanceFeatureSteps(standardFlow.page)
        await expect(
          standardFlow.page.getByRole('heading', { name: 'Microphone Access' })
        ).toBeVisible()

        const firstBackHeading = await clickBack(standardFlow.page)
        const secondBackHeading = await clickBack(standardFlow.page)
        await standardFlow.page.reload()
        await expect(standardFlow.page.getByRole('heading', { name: 'How It Works' })).toBeVisible()

        reproduced ||=
          firstBackHeading !== 'Notes That Think' || secondBackHeading !== 'How It Works'
        evidence.push(`feature flow after first Back: ${firstBackHeading}`)
        evidence.push(`feature flow after second Back: ${secondBackHeading}`)
        evidence.push('feature flow after reload: How It Works')
      } finally {
        await standardFlow.app.cleanup()
      }

      const grantedPermissionsFlow = await launchQaApp({
        permissions: {
          microphone: true,
          screen: true
        }
      })

      try {
        await advanceFeatureSteps(grantedPermissionsFlow.page)
        await expect(
          grantedPermissionsFlow.page.getByRole('heading', { name: 'Connect Calendar' })
        ).toBeVisible()

        const calendarBackHeading = await clickBack(grantedPermissionsFlow.page)
        const permissionsBackHeading = await clickBack(grantedPermissionsFlow.page)

        reproduced ||= calendarBackHeading !== 'Screen Recording'
        reproduced ||= permissionsBackHeading !== 'Microphone Access'
        evidence.push(`calendar flow after first Back: ${calendarBackHeading}`)
        evidence.push(`calendar flow after second Back: ${permissionsBackHeading}`)
      } finally {
        await grantedPermissionsFlow.app.cleanup()
      }

      await attachReproNote(testInfo, {
        issue: 'AD-59',
        reproduced,
        evidence
      })

      expect(reproduced, evidence.join('\n')).toBe(false)
    } catch (error) {
      await attachReproNote(testInfo, {
        issue: 'AD-59',
        reproduced: 'not-verifiable',
        evidence,
        limitation: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })

  test('AD-60 verifies the app-side microphone permission request path in a sandbox', async ({}, testInfo) => {
    const { app, page } = await launchQaApp()

    try {
      await reachMicStep(page)
      await page.evaluate(() => {
        ;(window as typeof window & { __qaMicRequests?: unknown[] }).__qaMicRequests = []
        if (!navigator.mediaDevices) {
          Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: {}
          })
        }
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          ;(window as typeof window & { __qaMicRequests: unknown[] }).__qaMicRequests.push(
            constraints
          )
          throw new DOMException('Permission denied by QA sandbox', 'NotAllowedError')
        }
      })

      await page.getByRole('button', { name: /enable microphone/i }).click()
      await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
      const micRequests = await page.evaluate(
        () => (window as typeof window & { __qaMicRequests?: unknown[] }).__qaMicRequests ?? []
      )
      const permissionRequestState = await page.evaluate(async () => {
        return await window.electronAPI.invoke('e2e:get-permission-request-state')
      })

      await attachReproNote(testInfo, {
        issue: 'AD-60',
        reproduced: 'not-verifiable',
        evidence: [
          `navigator.mediaDevices.getUserMedia calls: ${JSON.stringify(micRequests)}`,
          `app-side microphone permission requests: ${permissionRequestState.microphoneRequests}`,
          'AutoDoc moved to the macOS-settings recovery state after the denied request.'
        ],
        limitation:
          'The isolated E2E app cannot inspect the real macOS Privacy > Microphone app list.'
      })
    } finally {
      await app.cleanup()
    }
  })

  test('AD-61 and AD-62 complete onboarding calendar connection buttons', async ({}, testInfo) => {
    const evidence: string[] = []

    for (const provider of ['Google Calendar', 'Microsoft Outlook']) {
      const { app, page } = await launchQaApp()

      try {
        await reachCalendarStep(page)
        await page.getByRole('button', { name: new RegExp(`connect ${provider}`, 'i') }).click()
        await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
        await expect(page.getByRole('button', { name: /^continue/i })).toBeVisible()
        await expect(page.getByRole('alert')).toBeHidden()
        evidence.push(`${provider}: connection completed and Continue became visible`)
      } finally {
        await app.cleanup()
      }
    }

    await attachReproNote(testInfo, {
      issue: 'AD-61/AD-62',
      reproduced: false,
      evidence,
      limitation:
        'The sandbox validates that both onboarding buttons complete through the app IPC path; the provider-hosted OAuth pages still require real provider credentials.'
    })
  })

  test('AD-63 completes main UI calendar connection buttons', async ({}, testInfo) => {
    const evidence: string[] = []

    for (const provider of ['Google Calendar', 'Microsoft Outlook']) {
      const { app, page } = await launchQaApp()

      try {
        await completeOnboarding(page)
        await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
        await page.getByRole('button', { name: new RegExp(`connect ${provider}`, 'i') }).click()
        await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
        await expect(page.getByText(/no upcoming meetings/i)).toBeVisible()
        await expect(page.getByRole('alert')).toBeHidden()
        evidence.push(`${provider}: connection completed and Upcoming entered connected state`)
      } finally {
        await app.cleanup()
      }
    }

    await attachReproNote(testInfo, {
      issue: 'AD-63',
      reproduced: false,
      evidence,
      limitation:
        'The sandbox validates that both main UI buttons complete through the app IPC path; real OAuth/provider failures need provider credentials or captured logs.'
    })
  })

  test('AD-65 keeps onboarding moving through speech engine setup failures', async ({}, testInfo) => {
    // This intentionally simulates the old v0.1.19-style onboarding failure mode:
    // Whisper setup reports repeated errors at the transcription step. Before the
    // recovery work, that state effectively trapped users on this screen with retry-only
    // UI. The assertions below verify that the current branch keeps onboarding recoverable.
    const failureStatus: WhisperSetupStatus = {
      phase: 'error',
      percent: 0,
      error: 'whisper-cli failed startup validation after setup.',
      failedStep: 'downloading-whisper'
    }
    const { app, page } = await launchQaApp({
      whisper: {
        status: failureStatus,
        retryStatuses: [failureStatus, failureStatus]
      }
    })

    try {
      await reachTranscriptionStep(page)
      await expect(page.getByText(/still finishing transcription setup/i)).toBeVisible({
        timeout: 2_500
      })
      await expect(
        page.getByRole('button', { name: /continue - this will finish in the background/i })
      ).toBeVisible({ timeout: 4_000 })
      await expect(page.getByRole('button', { name: /^retry$/i })).toBeVisible({
        timeout: 5_000
      })
      const finalRecoverableError = await visibleText(
        page,
        /transcription setup is taking longer than expected/i
      )
      const backgroundContinueVisible = await visibleText(
        page,
        /continue - this will finish in the background/i
      )
      await page
        .getByRole('button', { name: /continue - this will finish in the background/i })
        .click()
      await expect(
        page.getByRole('heading', { name: /ai model ready|setting up ai/i })
      ).toBeVisible()

      await attachReproNote(testInfo, {
        issue: 'AD-65',
        reproduced: false,
        evidence: [
          `recoverable setup message visible after auto retries: ${finalRecoverableError}`,
          `background continue visible: ${backgroundContinueVisible}`,
          'onboarding advanced to the AI setup step after continuing in the background'
        ]
      })
    } finally {
      await app.cleanup()
    }
  })

  test('AD-74 waits for user confirmation after transcription and AI setup become ready', async ({}, testInfo) => {
    const { app, page } = await launchQaApp({
      platform: 'win32',
      whisper: {
        status: {
          phase: 'downloading-whisper',
          percent: 12
        }
      },
      ollama: {
        status: {
          phase: 'starting',
          percent: 0
        }
      }
    })

    try {
      await advanceFeatureSteps(page)
      await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
      await page.getByRole('button', { name: /skip for now/i }).click()

      await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
      await setWhisperStatus(page, {
        phase: 'ready',
        percent: 100
      })
      await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
      await page.waitForTimeout(2000)
      await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: /Setting Up AI|AI Model Ready/i })
      ).toBeHidden()

      await page.getByRole('button', { name: /^continue$/i }).click()
      await expect(page.getByRole('heading', { name: 'Setting Up AI' })).toBeVisible()
      await setOllamaStatus(page, {
        phase: 'ready',
        percent: 100
      })
      await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
      await page.waitForTimeout(2000)
      await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeHidden()

      await page.getByRole('button', { name: /^continue$/i }).click()
      await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()

      await attachReproNote(testInfo, {
        issue: 'AD-74',
        reproduced: false,
        evidence: [
          'Windows onboarding stayed on Transcription Ready for 2s after setup reached ready.',
          'Windows onboarding stayed on AI Model Ready for 2s after setup reached ready.',
          'Both steps advanced only after pressing Continue.'
        ]
      })
    } finally {
      await app.cleanup()
    }
  })

  test('AD-67 checks recording recovery when the default microphone changes', async ({}, testInfo) => {
    const { app, page } = await launchQaApp({
      permissions: {
        microphone: true,
        screen: true
      }
    })

    try {
      await completeOnboarding(page)
      await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
      await installFakeCaptureDevices(page)

      await page.getByRole('button', { name: /^record$/i }).click()
      await page.getByRole('button', { name: /E2E Display/i }).click()
      await expect(page.getByRole('button', { name: /stop recording/i })).toBeVisible()

      const beforeSwitchCalls = await getCaptureRequestCount(page)
      await page.evaluate(() =>
        (window as typeof window & { __qaSwitchDefaultMic?: () => void }).__qaSwitchDefaultMic?.()
      )
      await expect
        .poll(() => getCaptureRequestCount(page), { timeout: 4_000 })
        .toBeGreaterThan(beforeSwitchCalls)
      const afterSwitchCalls = await getCaptureRequestCount(page)
      await page.getByRole('button', { name: /stop recording/i }).click()

      await attachReproNote(testInfo, {
        issue: 'AD-67',
        reproduced: false,
        evidence: [
          `capture getUserMedia calls before mic switch: ${beforeSwitchCalls}`,
          `capture getUserMedia calls after mic switch: ${afterSwitchCalls}`,
          'Device-change recovery re-entered capture in the sandbox.'
        ],
        limitation:
          'This validates capture recovery after a microphone route change; it cannot prove transcription quality without real recorded audio.'
      })
    } finally {
      await app.cleanup()
    }
  })
})

async function getCaptureRequestCount(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      (window as typeof window & { __qaCaptureRequests?: unknown[] }).__qaCaptureRequests?.length ??
      0
  )
}

async function installFakeCaptureDevices(page: Page): Promise<void> {
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
