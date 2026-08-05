import { execFileSync } from 'node:child_process'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  completeOnboarding,
  launchIsolatedE2EAppWithEnv,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'
import type { E2EFeedbackPromptFixture, E2EScenario } from '../src/shared/e2e'

async function launchFeedbackApp(scenario?: E2EScenario) {
  return await launchIsolatedE2EAppWithEnv(
    { AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com' },
    scenario
  )
}

async function installFeedbackFixture(
  electronApp: ElectronApplication,
  page: Page,
  fixture: E2EFeedbackPromptFixture
): Promise<void> {
  const installed = await page.evaluate(async (nextFixture) => {
    return await window.electronAPI.invoke('e2e:set-feedback-prompt-fixture', nextFixture)
  }, fixture)
  expect(installed).toBe(true)
  await page.reload()
  await electronApp.evaluate(async ({ app, BrowserWindow }) => {
    if (process.platform === 'darwin') {
      await app.dock?.show()
      app.focus({ steal: true })
    }
    const window = BrowserWindow.getAllWindows()[0]
    window?.show()
    window?.focus()
  })
  await page.bringToFront()
  if (process.platform === 'darwin') {
    const pid = electronApp.process().pid
    if (pid) {
      execFileSync('/usr/bin/osascript', [
        '-e',
        `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`
      ])
      await page.waitForTimeout(100)
    }
  }

  // The standard calendar-connect toast is intentionally a critical-UI suppression
  // gate. Close it so these cases can exercise the feedback surface itself.
  await page
    .getByTitle('Dismiss')
    .click({ timeout: 1_500 })
    .catch(() => {})

  const debugState = await page.evaluate(async () => {
    return await window.electronAPI.invoke('e2e:get-feedback-prompt-debug')
  })
  expect(debugState.windowForegrounded).toBe(true)
  expect(debugState.supportAvailable).toBe(true)
}

test('shows and durably acknowledges the initial feedback prompt', async () => {
  const app = await launchFeedbackApp()

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFeedbackFixture(app.electronApp, page, 'initial-eligible')

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await expect(
      prompt.getByText('Tell us what’s working, what’s missing, or what AutoDoc could do better.')
    ).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Share feedback' })).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Maybe later' })).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Don’t ask again' })).toBeVisible()

    await prompt.getByRole('button', { name: 'Maybe later' }).click()
    await expect(prompt).toHaveCount(0)
  } finally {
    await app.cleanup()
  }
})

test('shows the final reminder with its reminder-only action', async () => {
  const app = await launchFeedbackApp()

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFeedbackFixture(app.electronApp, page, 'reminder-eligible')

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Dismiss' })).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Maybe later' })).toHaveCount(0)

    await prompt.getByRole('button', { name: 'Dismiss' }).click()
    await expect(prompt).toHaveCount(0)
  } finally {
    await app.cleanup()
  }
})

test('suppresses future prompts after a feedback draft opens', async () => {
  const app = await launchFeedbackApp()

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFeedbackFixture(app.electronApp, page, 'initial-eligible')
    await app.electronApp.evaluate(({ shell }) => {
      shell.openExternal = async () => {}
    })

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await prompt.getByRole('button', { name: 'Share feedback' }).click()
    await expect(prompt).toHaveCount(0)

    const debugState = await page.evaluate(async () => {
      return await window.electronAPI.invoke('e2e:get-feedback-prompt-debug')
    })
    expect(debugState.reason).toBe('contact-initiated')

    await page.reload()
    await expect(prompt).toHaveCount(0)
  } finally {
    await app.cleanup()
  }
})

test('suppresses both feedback surfaces for an imminent meeting', async () => {
  const now = Date.now()
  const app = await launchFeedbackApp({
    calendar: {
      accounts: [
        {
          id: 'account-1',
          provider: 'google',
          email: 'qa@example.com',
          connectedAt: now
        }
      ],
      events: [
        {
          id: 'google-meeting-1',
          externalId: 'meeting-1',
          accountId: 'account-1',
          provider: 'google',
          recurringEventId: null,
          title: 'Imminent meeting',
          startTime: now + 5 * 60 * 1000,
          endTime: now + 35 * 60 * 1000,
          attendees: [],
          meetingUrl: null,
          autoRecord: 'off',
          syncedAt: now
        }
      ]
    }
  })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFeedbackFixture(app.electronApp, page, 'initial-eligible')

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(page.getByText('Imminent meeting')).toBeVisible()
    await expect(prompt).toHaveCount(0)

    await page.getByRole('link', { name: 'AI Notes' }).click()
    await expect(prompt).toHaveCount(0)
  } finally {
    await app.cleanup()
  }
})

test('hides a confirmed prompt while the meeting-detection prompt is visible', async () => {
  const app = await launchFeedbackApp({ platform: 'darwin' })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFeedbackFixture(app.electronApp, page, 'initial-eligible')

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Share feedback' })).toBeEnabled()

    const notificationWindowPromise = app.electronApp.waitForEvent('window')
    await setDetectionState(page, { providerActiveIds: ['us.zoom.xos'] })
    await pollDetection(page)
    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByRole('button', { name: 'Start AI Notes' })).toBeVisible()
    await expect(prompt).toHaveCount(0)

    const notificationClosed = notificationWindow.waitForEvent('close')
    await notificationWindow.locator('#dismiss').click()
    await notificationClosed

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.show()
      mainWindow?.focus()
    })
    await page.bringToFront()
    await expect(prompt).toBeVisible()
  } finally {
    await app.cleanup()
  }
})
