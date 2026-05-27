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

test('keeps long Notes Ready titles elided inside a stable notification', async ({}, testInfo) => {
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
    await expect(notificationWindow.getByText(/notes are ready\./)).toBeVisible()

    const metrics = await notificationWindow.evaluate(() => {
      const toast = document.querySelector('.toast')?.getBoundingClientRect()
      const subtitle = document.querySelector('.subtitle')?.getBoundingClientRect()
      const text = document.querySelector('.text')?.getBoundingClientRect()
      const dot = document.querySelector('.dot')?.getBoundingClientRect()
      const actions = document.querySelector('.actions')?.getBoundingClientRect()
      const centerY = (rect?: DOMRect) => (rect ? rect.top + rect.height / 2 : 0)
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        toastHeight: toast?.height ?? 0,
        subtitleHeight: subtitle?.height ?? 0,
        dotOffsetFromTextCenter: Math.abs(centerY(dot ?? undefined) - centerY(text ?? undefined)),
        actionsOffsetFromTextCenter: Math.abs(
          centerY(actions ?? undefined) - centerY(text ?? undefined)
        )
      }
    })

    expect(metrics.innerWidth).toBe(400)
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.innerHeight)
    expect(metrics.toastHeight).toBeLessThanOrEqual(104)
    expect(metrics.subtitleHeight).toBeGreaterThan(20)
    expect(metrics.dotOffsetFromTextCenter).toBeLessThanOrEqual(1)
    expect(metrics.actionsOffsetFromTextCenter).toBeLessThanOrEqual(1)

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
    await expect(repeatNotification.getByText('Reprocess Review notes are ready.')).toBeVisible()
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
