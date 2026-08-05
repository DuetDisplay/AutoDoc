import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  launchIsolatedE2EAppWithEnv,
  launchPackagedRealSetupApp
} from './helpers/electron-app'

test('keeps Email Us accessible in the sidebar footer', async () => {
  const packagedAppPath = process.env.AUTODOC_E2E_PACKAGED_APP
  const app = packagedAppPath
    ? await launchPackagedRealSetupApp(packagedAppPath, {
        AUTODOC_E2E: '1',
        AUTODOC_TEST_REAL_SETUP: '0'
      })
    : await launchIsolatedE2EAppWithEnv({
        AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com'
      })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    const emailUs = page.getByRole('button', { name: 'Email Us' })

    await expect(emailUs).toBeVisible()
    await expect(emailUs).toBeEnabled()
    await expect(page.getByText('Settings', { exact: true })).toBeVisible()

    await emailUs.focus()
    await expect(emailUs).toBeFocused()
  } finally {
    await app.cleanup()
  }
})
