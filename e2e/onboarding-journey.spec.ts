import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { E2EScenario } from '../src/shared/e2e'
import { launchE2EApp, stubMediaCapture } from './helpers/electron-app'

async function launchOnboarding(scenario?: E2EScenario): Promise<{
  electronApp: ElectronApplication
  page: Page
}> {
  const electronApp = await launchE2EApp(scenario)
  const page = await electronApp.firstWindow()

  await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

  return { electronApp, page }
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

async function completeDeniedPermissionSteps(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Microphone Access' })).toBeVisible()
  await stubMediaCapture(page)
  await page.getByRole('button', { name: /enable microphone/i }).click()
  await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
  await page.getByRole('button', { name: /continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Screen Recording' })).toBeVisible()
  await page.getByRole('button', { name: /enable screen recording/i }).click()
  await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
  await page.getByRole('button', { name: /continue/i }).click()
}

async function reachCalendarStep(page: Page): Promise<void> {
  await advanceFeatureSteps(page)
  await completeDeniedPermissionSteps(page)
  await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
}

async function reachTranscriptionStep(page: Page): Promise<void> {
  await reachCalendarStep(page)
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page.getByRole('heading', { name: /transcription/i })).toBeVisible()
}

async function reachOllamaStep(page: Page): Promise<void> {
  await reachTranscriptionStep(page)
  await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  await page.getByRole('button', { name: /^continue$/i }).click()
  await expect(page.getByRole('heading', { name: /AI/i })).toBeVisible()
}

async function finishOnboardingIntoApp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  await page.getByRole('button', { name: /^continue$/i }).click()

  await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
  await page.getByRole('button', { name: /^continue$/i }).click()

  await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()
  await page.getByRole('button', { name: /what exactly do we track/i }).click()
  await expect(page.getByText(/feature usage/i)).toBeVisible()
  await page.getByRole('button', { name: /no thanks/i }).click()

  await expect(page.getByRole('heading', { name: "You're All Set" })).toBeVisible()
  await page.getByRole('button', { name: /open autodoc/i }).click()

  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('AutoDoc')).toBeVisible()
}

test('completes the onboarding journey and opens the app shell', async () => {
  test.slow()

  const { electronApp, page } = await launchOnboarding()

  try {
    await reachTranscriptionStep(page)
    await finishOnboardingIntoApp(page)
  } finally {
    await electronApp.close()
  }
})

test('auto-advances permission steps when access is already granted', async () => {
  const { electronApp, page } = await launchOnboarding({
    permissions: {
      microphone: true,
      screen: true,
    },
  })

  try {
    await advanceFeatureSteps(page)
    await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('allows onboarding to connect a calendar account in e2e mode', async () => {
  const { electronApp, page } = await launchOnboarding()

  try {
    await reachCalendarStep(page)
    await page.getByRole('button', { name: /connect google calendar/i }).click()
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible()
    await page.getByRole('button', { name: /continue/i }).click()
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('shows Whisper install guidance and can recover after retry', async () => {
  const { electronApp, page } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'error',
        percent: 0,
        error: 'brew install whisper-cpp',
        failedStep: 'downloading-whisper',
      },
      retryStatus: {
        phase: 'ready',
        percent: 100,
      },
    },
  })

  try {
    await reachTranscriptionStep(page)
    await expect(page.getByRole('heading', { name: 'Install Whisper to Continue' })).toBeVisible()
    await expect(page.getByText(/brew install whisper-cpp/i)).toBeVisible()
    await page.getByRole('button', { name: /retry after installing/i }).click()
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('shows FFmpeg install guidance when audio tools are missing', async () => {
  const { electronApp, page } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'error',
        percent: 0,
        error: 'brew install ffmpeg',
        failedStep: 'downloading-ffmpeg',
      },
    },
  })

  try {
    await reachTranscriptionStep(page)
    await expect(page.getByRole('heading', { name: 'Install FFmpeg to Continue' })).toBeVisible()
    await expect(page.getByText(/brew install ffmpeg/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /retry after installing/i })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('shows Ollama setup failure and can recover after retry', async () => {
  const { electronApp, page } = await launchOnboarding({
    ollama: {
      status: {
        phase: 'error',
        percent: 0,
        error: 'Managed Ollama failed to start',
        failedStep: 'starting',
      },
      retryStatus: {
        phase: 'ready',
        percent: 100,
      },
    },
  })

  try {
    await reachOllamaStep(page)
    await expect(page.getByText(/setup failed: Managed Ollama failed to start/i)).toBeVisible()
    await page.getByRole('button', { name: /^retry$/i }).click()
    await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
