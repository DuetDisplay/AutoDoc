import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  completeOnboarding,
  launchIsolatedE2EApp,
  launchPackagedRealSetupApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'

interface MainWindowState {
  visible: boolean
  minimized: boolean
  focused: boolean
}

async function completeAndSettleOnboarding(
  electronApp: ElectronApplication,
  page: Page
): Promise<void> {
  // Finish the initial native ready-to-show cycle before arranging background
  // window state. Renderer navigation can finish before this startup show().
  await expect.poll(async () => (await getMainWindowState(electronApp)).visible).toBe(true)
  if (process.platform === 'win32') {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      if (!mainWindow) throw new Error('Main window is missing')
      ;(globalThis as { __e2eOnboardingReloadReady?: Promise<void> }).__e2eOnboardingReloadReady =
        new Promise<void>((resolve) => mainWindow.once('ready-to-show', () => resolve()))
    })
  }
  await completeOnboarding(page)
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  if (process.platform === 'win32') {
    // Windows emits another native ready-to-show for this onboarding reload.
    // Its startup show() must settle before the test hides/blurs the window.
    await electronApp.evaluate(
      () =>
        (globalThis as { __e2eOnboardingReloadReady?: Promise<void> }).__e2eOnboardingReloadReady
    )
  }
}

async function launchMeetingDetectionApp(): Promise<
  Awaited<ReturnType<typeof launchIsolatedE2EApp>>
> {
  const packagedAppPath = process.env.AUTODOC_E2E_PACKAGED_APP
  if (packagedAppPath) {
    return await launchPackagedRealSetupApp(packagedAppPath, {
      AUTODOC_E2E: '1',
      AUTODOC_TEST_REAL_SETUP: '0',
      AUTODOC_E2E_SCENARIO: JSON.stringify({ platform: 'darwin' })
    })
  }
  return await launchIsolatedE2EApp({ platform: 'darwin' })
}

async function getMainWindowState(electronApp: ElectronApplication): Promise<MainWindowState> {
  return await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
    return {
      visible: mainWindow?.isVisible() ?? false,
      minimized: mainWindow?.isMinimized() ?? false,
      focused: mainWindow?.isFocused() ?? false
    }
  })
}

// Electron's activate event models a macOS Dock/app activation. Windows
// dismissal checks should observe native window state without inventing it.
async function emitMacActivation(electronApp: ElectronApplication): Promise<void> {
  if (process.platform === 'darwin') {
    await electronApp.evaluate(({ app }) => app.emit('activate'))
  }
}

async function triggerMeetingPrompt(electronApp: ElectronApplication, page: Page): Promise<Page> {
  const notificationWindowPromise = electronApp.waitForEvent('window')
  await setDetectionState(page, { providerActiveIds: ['us.zoom.xos'] })
  await pollDetection(page)

  const notificationWindow = await notificationWindowPromise
  await expect(notificationWindow.getByText('Zoom', { exact: true })).toBeVisible()
  await expect(notificationWindow.getByRole('button', { name: 'Start AI Notes' })).toBeVisible()
  return notificationWindow
}

test('dismisses a meeting prompt without showing a hidden main window', async () => {
  const session = await launchMeetingDetectionApp()

  try {
    const page = await session.electronApp.firstWindow()
    await completeAndSettleOnboarding(session.electronApp, page)
    await session.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.isFocusable())
        ?.hide()
    })
    await expect
      .poll(async () => (await getMainWindowState(session.electronApp)).visible)
      .toBe(false)

    const notificationWindow = await triggerMeetingPrompt(session.electronApp, page)
    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: false,
      focused: false
    })

    // Reproduce the macOS ordering: app activation can arrive before dismiss IPC.
    await emitMacActivation(session.electronApp)
    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: false,
      focused: false
    })

    const notificationClosed = notificationWindow.waitForEvent('close')
    await notificationWindow.locator('#dismiss').click()
    await notificationClosed

    // The trailing suppression also protects the close animation/event tail.
    await emitMacActivation(session.electronApp)
    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: false,
      focused: false
    })
  } finally {
    await session.cleanup()
  }
})

test('dismisses a meeting prompt without restoring a minimized main window', async () => {
  const session = await launchMeetingDetectionApp()

  try {
    const page = await session.electronApp.firstWindow()
    await completeAndSettleOnboarding(session.electronApp, page)
    await session.electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.hide()
      mainWindow?.showInactive()
      mainWindow?.minimize()
    })
    await expect
      .poll(async () => (await getMainWindowState(session.electronApp)).minimized)
      .toBe(true)

    const notificationWindow = await triggerMeetingPrompt(session.electronApp, page)
    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      minimized: true,
      focused: false
    })
    await emitMacActivation(session.electronApp)

    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      minimized: true,
      focused: false
    })

    const notificationClosed = notificationWindow.waitForEvent('close')
    await notificationWindow.locator('#dismiss').click()
    await notificationClosed
    await emitMacActivation(session.electronApp)

    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      minimized: true,
      focused: false
    })
  } finally {
    await session.cleanup()
  }
})

test('dismisses a meeting prompt without raising an unfocused visible main window', async () => {
  const session = await launchMeetingDetectionApp()

  try {
    const page = await session.electronApp.firstWindow()
    await completeAndSettleOnboarding(session.electronApp, page)
    await session.electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.hide()
      mainWindow?.showInactive()
    })
    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: true,
      focused: false
    })

    const notificationWindow = await triggerMeetingPrompt(session.electronApp, page)
    await emitMacActivation(session.electronApp)

    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: process.platform !== 'darwin',
      focused: false
    })

    const notificationClosed = notificationWindow.waitForEvent('close')
    await notificationWindow.locator('#dismiss').click()
    await notificationClosed
    await emitMacActivation(session.electronApp)

    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: process.platform !== 'darwin',
      focused: false
    })
  } finally {
    await session.cleanup()
  }
})

test('Start AI Notes still opens the main window and broadcasts auto-record', async () => {
  const session = await launchMeetingDetectionApp()

  try {
    const page = await session.electronApp.firstWindow()
    await completeAndSettleOnboarding(session.electronApp, page)
    await page.evaluate(() => {
      const qaWindow = window as typeof window & {
        __qaAutoRecordEvents?: unknown[]
      }
      qaWindow.__qaAutoRecordEvents = []
      window.electronAPI.on('detection:auto-record', (payload) => {
        qaWindow.__qaAutoRecordEvents?.push(payload)
      })
    })
    await session.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.isFocusable())
        ?.hide()
    })

    const notificationWindow = await triggerMeetingPrompt(session.electronApp, page)
    const notificationClosed = notificationWindow.waitForEvent('close')
    await notificationWindow.getByRole('button', { name: 'Start AI Notes' }).click()
    await notificationClosed

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const qaWindow = window as typeof window & {
            __qaAutoRecordEvents?: unknown[]
          }
          return qaWindow.__qaAutoRecordEvents?.length ?? 0
        })
      })
      .toBe(1)

    expect(await getMainWindowState(session.electronApp)).toMatchObject({
      visible: true,
      minimized: false
    })
  } finally {
    await session.cleanup()
  }
})
