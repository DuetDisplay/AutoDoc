import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { E2EScenario } from '../src/shared/e2e'
import {
  launchE2EApp,
  launchIsolatedE2EApp,
  relaunchIsolatedE2EApp,
  setOllamaStatus,
  setWhisperStatus,
  stubMediaCapture
} from './helpers/electron-app'

async function launchOnboarding(scenario?: E2EScenario): Promise<{
  electronApp: ElectronApplication
  page: Page
  cleanup: () => Promise<void>
}> {
  const session = await launchIsolatedE2EApp(scenario)
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

  return { electronApp, page, cleanup: session.cleanup }
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

async function completeHostPermissionSteps(page: Page): Promise<void> {
  if (process.platform === 'win32') {
    await expect(page.getByRole('heading', { name: 'Microphone Access' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Screen Recording' })).toHaveCount(0)
    return
  }

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
  await completeHostPermissionSteps(page)
  await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
}

async function reachTranscriptionStep(page: Page): Promise<void> {
  await reachCalendarStep(page)
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(
    page.getByRole('heading', { name: /^(Setting Up Transcription|Transcription Ready)$/i })
  ).toBeVisible()
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

async function finishAnalyticsAndOpenApp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()
  await page.getByRole('button', { name: /no thanks/i }).click()
  await expect(page.getByRole('heading', { name: "You're All Set" })).toBeVisible()
  await page.getByRole('button', { name: /open autodoc/i }).click()
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
}

async function completeDependencySetup(page: Page): Promise<void> {
  await reachTranscriptionStep(page)
  await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  await page.getByRole('button', { name: /^continue$/i }).click()

  await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
  await page.getByRole('button', { name: /^continue$/i }).click()
  await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
}

test('completes the onboarding journey and opens the app shell', async () => {
  test.slow()

  const { page, cleanup } = await launchOnboarding()

  try {
    await reachTranscriptionStep(page)
    await finishOnboardingIntoApp(page)
  } finally {
    await cleanup()
  }
})

test('preserves the diagnostic log upload draft when navigating back and forward in onboarding', async () => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await completeDependencySetup(page)

    const logUploadCheckbox = page.getByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    await expect(logUploadCheckbox).toBeChecked()
    await logUploadCheckbox.uncheck()
    await expect(logUploadCheckbox).not.toBeChecked()

    await page.getByRole('button', { name: /back/i }).click()
    await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
    await page.getByRole('button', { name: /^continue$/i }).click()
    await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()
    await expect(logUploadCheckbox).not.toBeChecked()
  } finally {
    await session.cleanup()
  }
})

test('persists analytics opt-in with diagnostic log upload disabled across relaunch', async () => {
  const session = await launchIsolatedE2EApp()
  let { electronApp, userDataDir } = session
  let page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await completeDependencySetup(page)

    const logUploadCheckbox = page.getByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    await logUploadCheckbox.uncheck()
    await expect(logUploadCheckbox).not.toBeChecked()

    await page.getByRole('button', { name: /share anonymous data/i }).click()
    await expect(page.getByRole('heading', { name: "You're All Set" })).toBeVisible()
    await page.getByRole('button', { name: /open autodoc/i }).click()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    await openSettings(page)
    await expect(
      page.getByRole('button', { name: /toggle analytics and crash reports/i })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(logUploadCheckbox).not.toBeChecked()

    await electronApp.close()
    const relaunched = await relaunchIsolatedE2EApp(userDataDir)
    electronApp = relaunched.electronApp
    page = await electronApp.firstWindow()

    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
    await openSettings(page)
    await expect(
      page.getByRole('button', { name: /toggle analytics and crash reports/i })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByRole('checkbox', { name: /attach technical app logs to error reports/i })
    ).not.toBeChecked()
  } finally {
    await session.cleanup()
  }
})

test('persists analytics opt-in with diagnostic log upload enabled after onboarding', async () => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await completeDependencySetup(page)

    const logUploadCheckbox = page.getByRole('checkbox', {
      name: /attach technical app logs to error reports/i
    })
    await expect(logUploadCheckbox).toBeChecked()

    await page.getByRole('button', { name: /share anonymous data/i }).click()
    await expect(page.getByRole('heading', { name: "You're All Set" })).toBeVisible()
    await page.getByRole('button', { name: /open autodoc/i }).click()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    await openSettings(page)
    await expect(
      page.getByRole('button', { name: /toggle analytics and crash reports/i })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(logUploadCheckbox).toBeChecked()
  } finally {
    await session.cleanup()
  }
})

test('advances past permission steps when access is already granted or not required', async () => {
  const { page, cleanup } = await launchOnboarding({
    permissions: {
      microphone: true,
      screen: true,
    },
  })

  try {
    await advanceFeatureSteps(page)
    await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('allows onboarding to connect a calendar account in e2e mode', async () => {
  const { page, cleanup } = await launchOnboarding()

  try {
    await reachCalendarStep(page)
    await page.getByRole('button', { name: /connect google calendar/i }).click()
    await expect(page.getByRole('button', { name: /continue/i })).toBeVisible()
    await page.getByRole('button', { name: /continue/i }).click()
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('stays on the calendar step when connection fails', async () => {
  const { page, cleanup } = await launchOnboarding({
    calendar: {
      connectSucceeds: false,
    },
  })

  try {
    await reachCalendarStep(page)
    await page.getByRole('button', { name: /connect google calendar/i }).click()
    await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
    await expect(page.getByRole('button', { name: /skip for now/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /connect google calendar/i })).toBeEnabled()
  } finally {
    await cleanup()
  }
})

test('shows managed Whisper setup failure and can recover after retry', async () => {
  const { page, cleanup } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'error',
        percent: 0,
        error: 'AutoDoc could not finish setting up transcription.',
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
    await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
    await expect(page.getByText(/still finishing transcription setup/i)).toBeVisible()
    await expect(page.getByText(/brew install/i)).not.toBeVisible()
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('shows Whisper download progress and allows skipping while setup continues', async () => {
  test.slow()

  const { page, cleanup } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'downloading-model',
        percent: 42,
      },
    },
  })

  try {
    await reachTranscriptionStep(page)
    await expect(page.getByText(/downloading speech model\.\.\. 42%/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /continue - this will finish in the background/i })).toBeVisible({
      timeout: 7_000,
    })
    await page.getByRole('button', { name: /continue - this will finish in the background/i }).click()
    await expect(page.getByRole('heading', { name: /AI/i })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('shows a managed transcription setup error when audio tools are missing', async () => {
  const { page, cleanup } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'error',
        percent: 0,
        error: 'AutoDoc could not finish setting up its audio tools. Please reinstall AutoDoc and try again.',
        failedStep: 'downloading-ffmpeg',
      },
    },
  })

  try {
    await reachTranscriptionStep(page)
    await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
    await expect(page.getByText(/still finishing transcription setup/i)).toBeVisible()
    await expect(page.getByText(/transcription setup is taking longer than expected/i)).toBeVisible({
      timeout: 7_000,
    })
    await expect(page.getByText(/brew install/i)).not.toBeVisible()
    await expect(page.getByRole('button', { name: /^retry$/i })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('shows Ollama setup failure and can recover after retry', async () => {
  const { page, cleanup } = await launchOnboarding({
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
    await cleanup()
  }
})

test('shows Ollama download progress and allows skipping while setup continues', async () => {
  test.slow()

  const { page, cleanup } = await launchOnboarding({
    ollama: {
      status: {
        phase: 'downloading',
        percent: 67,
      },
    },
  })

  try {
    await reachOllamaStep(page)
    await expect(page.getByText(/downloading Ollama runtime\.\.\. 67%/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /continue - this will finish in the background/i })).toBeVisible({
      timeout: 7_000,
    })
    await page.getByRole('button', { name: /continue - this will finish in the background/i }).click()
    await expect(page.getByRole('heading', { name: 'Help Improve AutoDoc' })).toBeVisible()
  } finally {
    await cleanup()
  }
})

test('completes a full macOS onboarding flow with managed dependency setup', async () => {
  test.skip(process.platform !== 'darwin', 'macOS onboarding journey only runs on macOS hosts.')
  test.slow()

  const { page, cleanup } = await launchOnboarding({
    permissions: {
      microphone: false,
      screen: false,
    },
    whisper: {
      status: {
        phase: 'downloading-whisper',
        percent: 16,
      },
    },
    ollama: {
      status: {
        phase: 'starting',
        percent: 0,
      },
    },
  })

  try {
    await reachTranscriptionStep(page)
    await expect(page.getByText(/downloading transcription engine\.\.\. 16%/i)).toBeVisible()
    await expect(page.getByText(/brew install/i)).not.toBeVisible()
    await setWhisperStatus(page, {
      phase: 'downloading-ffmpeg',
      percent: 48,
    })
    await expect(page.getByText(/installing audio tools\.\.\. 48%/i)).toBeVisible()
    await setWhisperStatus(page, {
      phase: 'downloading-model',
      percent: 79,
    })
    await expect(page.getByText(/downloading speech model\.\.\. 79%/i)).toBeVisible()
    await setWhisperStatus(page, {
      phase: 'ready',
      percent: 100,
    })
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
    await page.getByRole('button', { name: /^continue$/i }).click()

    await expect(page.getByRole('heading', { name: /AI/i })).toBeVisible()
    await expect(page.getByText(/starting Ollama runtime/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'downloading',
      percent: 38,
    })
    await expect(page.getByText(/downloading Ollama runtime\.\.\. 38%/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'pulling',
      percent: 82,
    })
    await expect(page.getByText(/downloading Llama 3\.1 notes model\.\.\. 82%/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'ready',
      percent: 100,
    })
    await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
    await page.getByRole('button', { name: /^continue$/i }).click()
    await finishAnalyticsAndOpenApp(page)
  } finally {
    await cleanup()
  }
})

test('completes a full Windows onboarding flow with in-app dependency downloads', async () => {
  test.skip(process.platform !== 'win32', 'Windows onboarding journey only runs on Windows hosts.')
  test.slow()

  const { page, cleanup } = await launchOnboarding({
    whisper: {
      status: {
        phase: 'downloading-whisper',
        percent: 12,
      },
    },
    ollama: {
      status: {
        phase: 'starting',
        percent: 0,
      },
    },
  })

  try {
    await advanceFeatureSteps(page)
    await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
    await page.getByRole('button', { name: /skip for now/i }).click()

    await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
    await expect(page.getByText(/downloading transcription engine\.\.\. 12%/i)).toBeVisible()
    await expect(page.getByText(/brew install/i)).not.toBeVisible()
    await setWhisperStatus(page, {
      phase: 'downloading-ffmpeg',
      percent: 48,
    })
    await expect(page.getByText(/installing audio tools\.\.\. 48%/i)).toBeVisible()
    await setWhisperStatus(page, {
      phase: 'downloading-model',
      percent: 76,
    })
    await expect(page.getByText(/downloading speech model\.\.\. 76%/i)).toBeVisible()
    await setWhisperStatus(page, {
      phase: 'ready',
      percent: 100,
    })
    await expect(page.getByRole('heading', { name: 'Transcription Ready' })).toBeVisible()
    await page.getByRole('button', { name: /^continue$/i }).click()

    await expect(page.getByRole('heading', { name: /AI/i })).toBeVisible()
    await expect(page.getByText(/starting Ollama runtime/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'downloading',
      percent: 44,
    })
    await expect(page.getByText(/downloading Ollama runtime\.\.\. 44%/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'pulling',
      percent: 91,
    })
    await expect(page.getByText(/downloading Llama 3\.1 notes model\.\.\. 91%/i)).toBeVisible()
    await setOllamaStatus(page, {
      phase: 'ready',
      percent: 100,
    })
    await expect(page.getByRole('heading', { name: 'AI Model Ready' })).toBeVisible()
    await page.getByRole('button', { name: /^continue$/i }).click()
    await finishAnalyticsAndOpenApp(page)
  } finally {
    await cleanup()
  }
})
