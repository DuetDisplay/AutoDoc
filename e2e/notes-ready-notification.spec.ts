import { expect, test } from '@playwright/test'
import { launchIsolatedE2EApp, relaunchIsolatedE2EApp } from './helpers/electron-app'

test('shows a Notes Ready notification, opens the meeting, and does not re-notify after relaunch', async () => {
  const session = await launchIsolatedE2EApp()
  let { electronApp, userDataDir } = session
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

    await electronApp.close()
    const relaunched = await relaunchIsolatedE2EApp(userDataDir)
    electronApp = relaunched.electronApp
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
