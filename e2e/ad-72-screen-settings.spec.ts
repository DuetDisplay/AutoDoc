import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedE2EApp, stubMediaCapture } from './helpers/electron-app'

async function advanceToScreenRecording(page: Page) {
  await page.getByRole('button', { name: /get started/i }).click()
  await expect(page.getByRole('heading', { name: 'Private by Design' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'Notes That Think' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()

  await expect(page.getByRole('heading', { name: 'Microphone Access' })).toBeVisible()
  await stubMediaCapture(page)
  await page.getByRole('button', { name: /enable microphone/i }).click()
  await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()
  await page.getByRole('button', { name: /^continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Screen Recording' })).toBeVisible()
}

test('AD-72 primary screen CTA attempts to open System Settings when permission remains denied', async ({}, testInfo) => {
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: {
      microphone: false,
      screen: false,
    },
  })

  try {
    const page = await app.electronApp.firstWindow()
    await app.electronApp.evaluate(({ ipcMain }) => {
      const qaGlobal = globalThis as typeof globalThis & { __ad72Panels?: string[] }
      qaGlobal.__ad72Panels = []
      ipcMain.removeHandler('permissions:open-settings')
      ipcMain.handle('permissions:open-settings', async (_event, panel: string) => {
        qaGlobal.__ad72Panels?.push(panel)
      })
    })
    await advanceToScreenRecording(page)

    await stubMediaCapture(page)
    await page.getByRole('button', { name: /enable screen recording/i }).click()
    await expect(page.getByRole('button', { name: /open settings again/i })).toBeVisible()

    const panels = await app.electronApp.evaluate(() => {
      const qaGlobal = globalThis as typeof globalThis & { __ad72Panels?: string[] }
      return qaGlobal.__ad72Panels ?? []
    })

    const attemptedToOpenSettings = panels.includes('screen')

    await testInfo.attach('ad-72-open-settings-calls', {
      body: JSON.stringify({ expected: true, attemptedToOpenSettings, panels }, null, 2),
      contentType: 'application/json',
    })

    expect(attemptedToOpenSettings).toBe(true)
  } finally {
    await app.cleanup()
  }
})
