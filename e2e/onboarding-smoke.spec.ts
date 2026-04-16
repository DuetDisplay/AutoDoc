import { test, expect } from '@playwright/test'
import { launchE2EApp } from './helpers/electron-app'

test('launches and advances to the second onboarding step in e2e mode', async () => {
  const electronApp = await launchE2EApp()

  try {
    const page = await electronApp.firstWindow()

    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    const getStartedButton = page.getByRole('button', { name: /get started/i })
    await expect(getStartedButton).toBeVisible()

    await getStartedButton.click()

    await expect(page.getByRole('heading', { name: 'Private by Design' })).toBeVisible()
    await expect(page.getByRole('button', { name: /next/i })).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
