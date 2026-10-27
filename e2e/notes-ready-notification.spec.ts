import { expect, test } from '@playwright/test'
import {
  closeE2EAppKeepingUserData,
  launchIsolatedE2EApp,
  relaunchIsolatedE2EApp
} from './helpers/electron-app'

test('shows a Notes Ready notification, opens the meeting, and does not re-notify after relaunch', async () => {
  let session = await launchIsolatedE2EApp()
  let { electronApp } = session
  const { userDataDir } = session
  let page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    const notificationWindowPromise = electronApp.waitForEvent('window')
    const meetingId = await page.evaluate(async () => {
      return await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Roadmap Review'
      })
    })

    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByText('Notes Ready')).toBeVisible()
    await expect(notificationWindow.getByText(/Roadmap Review/)).toBeVisible()
    await notificationWindow.getByRole('button', { name: 'Open Notes' }).click()

    await expect
      .poll(async () => page.url(), { timeout: 5_000 })
      .toContain(`#/recordings/${meetingId}`)

    await closeE2EAppKeepingUserData(electronApp, userDataDir)
    session = await relaunchIsolatedE2EApp(userDataDir)
    electronApp = session.electronApp
    page = await electronApp.firstWindow()

    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    let duplicateAppeared = true
    const duplicateWindowPromise = electronApp
      .waitForEvent('window', { timeout: 1_500 })
      .then(() => {
        duplicateAppeared = true
      })
      .catch(() => {
        duplicateAppeared = false
      })

    await page.evaluate(async (nextMeetingId) => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        meetingId: nextMeetingId,
        title: 'Roadmap Review'
      })
    }, meetingId)
    await duplicateWindowPromise

    expect(duplicateAppeared).toBe(false)
  } finally {
    await session.cleanup()
  }
})

test('keeps long Notes Ready titles readable inside the resized notification', async ({}, testInfo) => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    const notificationWindowPromise = electronApp.waitForEvent('window')
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title:
          'Two Ways to Build a $750 Gaming PC - YouTube meeting with a very long planning title'
      })
    })

    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByText('Notes Ready')).toBeVisible()
    await expect(notificationWindow.getByText('Notes are ready.', { exact: true })).toBeVisible()
    await notificationWindow.evaluate(() => document.fonts.ready)
    await expect
      .poll(() =>
        notificationWindow.locator('.toast').evaluate((el) => el.getBoundingClientRect().top)
      )
      .toBeGreaterThanOrEqual(0)

    const metrics = await notificationWindow.evaluate(() => {
      const toast = document.querySelector('.toast')?.getBoundingClientRect()
      const subtitle = document.querySelector('.subtitle')?.getBoundingClientRect()
      const text = document.querySelector('.text')?.getBoundingClientRect()
      const dot = document.querySelector('.dot')?.getBoundingClientRect()
      const actions = document.querySelector('.actions')?.getBoundingClientRect()
      const meetingTitle = document.querySelector('.meeting-title') as HTMLElement
      const centerY = (rect?: DOMRect) => (rect ? rect.top + rect.height / 2 : 0)
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        toastHeight: toast?.height ?? 0,
        subtitleHeight: subtitle?.height ?? 0,
        meetingTitleFits:
          meetingTitle.scrollWidth <= meetingTitle.clientWidth &&
          meetingTitle.getBoundingClientRect().right <= innerWidth,
        toastFits: !!toast && toast.top >= 0 && toast.bottom <= innerHeight,
        actionsFit:
          !!actions &&
          !!toast &&
          actions.left >= toast.left &&
          actions.right <= toast.right &&
          actions.bottom <= toast.bottom,
        dotOffsetFromTextCenter: Math.abs(centerY(dot ?? undefined) - centerY(text ?? undefined)),
        actionsOffsetFromTextCenter: Math.abs(
          centerY(actions ?? undefined) - centerY(text ?? undefined)
        )
      }
    })

    expect(metrics.innerWidth).toBe(400)
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight)
    expect(metrics.toastFits).toBe(true)
    expect(metrics.meetingTitleFits).toBe(true)
    expect(metrics.actionsFit).toBe(true)
    expect(metrics.subtitleHeight).toBeGreaterThan(0)
    expect(metrics.dotOffsetFromTextCenter).toBeLessThanOrEqual(3)

    await notificationWindow.screenshot({
      path: testInfo.outputPath('notes-ready-long-title.png')
    })
  } finally {
    await session.cleanup()
  }
})

test('shows Notes Ready again when completion is from a manual reprocess', async () => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    const firstNotificationPromise = electronApp.waitForEvent('window')
    const meetingId = await page.evaluate(async () => {
      return await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Reprocess Review'
      })
    })
    const firstNotification = await firstNotificationPromise
    await expect(firstNotification.getByText('Notes Ready')).toBeVisible()
    await firstNotification.getByRole('button', { name: 'Open Notes' }).click()

    const repeatNotificationPromise = electronApp.waitForEvent('window')
    await page.evaluate(async (nextMeetingId) => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        meetingId: nextMeetingId,
        title: 'Reprocess Review',
        allowRepeat: true
      })
    }, meetingId)

    const repeatNotification = await repeatNotificationPromise
    await expect(repeatNotification.getByText('Notes Ready')).toBeVisible()
    await expect(repeatNotification.getByText('Reprocess Review', { exact: true })).toBeVisible()
    await expect(repeatNotification.getByText('Notes are ready.', { exact: true })).toBeVisible()
  } finally {
    await session.cleanup()
  }
})

test('dismissing Notes Ready does not reveal the main window', async () => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    const mainWindowHidden = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.hide()
      return mainWindow?.isVisible() === false
    })
    expect(mainWindowHidden).toBe(true)

    const notificationWindowPromise = electronApp.waitForEvent('window')
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Dismiss Review'
      })
    })

    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByText('Notes Ready')).toBeVisible()

    // A renderer click resolves before its asynchronous IPC necessarily arrives.
    // Emit the synthetic activation only after the real dismiss handler ran.
    await electronApp.evaluate(({ app, ipcMain, BrowserWindow }) => {
      ;(globalThis as any).__dismissActivationResult = null
      ipcMain.once('notification:dismiss', () => {
        app.emit('activate')
        app.emit('activate')
        const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
        ;(globalThis as any).__dismissActivationResult = {
          visible: mainWindow?.isVisible() ?? false
        }
      })
    })
    await notificationWindow.locator('#dismiss').click()
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__dismissActivationResult))
      .toEqual({ visible: false })
  } finally {
    await session.cleanup()
  }
})

test('Notes Ready hides an unfocused visible main window before it can be raised', async () => {
  test.skip(process.platform === 'win32', 'Windows keeps the main window visible')

  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.show()
      mainWindow?.blur()
    })

    const notificationWindowPromise = electronApp.waitForEvent('window')
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Visible Behind Review'
      })
    })

    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByText('Notes Ready')).toBeVisible()

    const mainWindowVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      return mainWindow?.isVisible() ?? false
    })
    expect(mainWindowVisible).toBe(false)

    await notificationWindow.locator('#dismiss').click()
    await electronApp.evaluate(({ app }) => {
      app.emit('activate')
      app.emit('activate')
    })

    const mainWindowVisibleAfterDismiss = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      return mainWindow?.isVisible() ?? false
    })
    expect(mainWindowVisibleAfterDismiss).toBe(false)
  } finally {
    await session.cleanup()
  }
})

test('Notes Ready keeps an unfocused visible main window visible on Windows', async () => {
  test.skip(
    process.platform === 'darwin',
    'macOS hides the main window before showing the notification'
  )

  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      mainWindow?.show()
      mainWindow?.blur()
    })

    const notificationWindowPromise = electronApp.waitForEvent('window')
    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Visible Behind Review'
      })
    })

    const notificationWindow = await notificationWindowPromise
    await expect(notificationWindow.getByText('Notes Ready')).toBeVisible()

    const mainWindowVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      return mainWindow?.isVisible() ?? false
    })
    expect(mainWindowVisible).toBe(true)

    await notificationWindow.locator('#dismiss').click()
    await electronApp.evaluate(({ app }) => {
      app.emit('activate')
      app.emit('activate')
    })

    const mainWindowVisibleAfterDismiss = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
      return mainWindow?.isVisible() ?? false
    })
    expect(mainWindowVisibleAfterDismiss).toBe(true)
  } finally {
    await session.cleanup()
  }
})

test('does not show a Notes Ready notification when segmentation fails', async () => {
  const session = await launchIsolatedE2EApp()
  const { electronApp } = session
  const page = await electronApp.firstWindow()

  try {
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    await page.evaluate(async () => {
      await window.electronAPI.invoke('prefs:set-onboarding-complete')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()

    let notificationAppeared = true
    const notificationWindowPromise = electronApp
      .waitForEvent('window', { timeout: 1_500 })
      .then(() => {
        notificationAppeared = true
      })
      .catch(() => {
        notificationAppeared = false
      })

    await page.evaluate(async () => {
      await window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
        title: 'Failed Meeting',
        status: 'failed'
      })
    })
    await notificationWindowPromise

    expect(notificationAppeared).toBe(false)
  } finally {
    await session.cleanup()
  }
})
