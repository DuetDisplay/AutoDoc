import { expect, test } from '@playwright/test'
import { launchPackagedRealSetupApp } from './helpers/electron-app'

const packagedAppPath = process.env.AUTODOC_E2E_PACKAGED_APP
const fakeAuthWorkerUrl = 'http://127.0.0.1:59999'

test('starts the patched packaged runtime and initializes updater and OAuth paths', async () => {
  test.skip(!packagedAppPath, 'Set AUTODOC_E2E_PACKAGED_APP to an unpacked AutoDoc.app.')
  test.setTimeout(45_000)

  const session = await launchPackagedRealSetupApp(packagedAppPath!, {
    AUTODOC_E2E: '0',
    AUTODOC_TEST_REAL_SETUP: '1',
    AUTODOC_AUTH_WORKER_URL: fakeAuthWorkerUrl,
    AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com'
  })

  try {
    const page = await session.electronApp.firstWindow()
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

    const electronVersion = await session.electronApp.evaluate(() => process.versions.electron)
    expect(electronVersion).toBe('41.10.3')

    await session.electronApp.evaluate(({ shell }) => {
      const state = { count: 0 }
      ;(
        globalThis as typeof globalThis & { __oauthOpenExternal?: typeof state }
      ).__oauthOpenExternal = state
      shell.openExternal = async () => {
        state.count += 1
      }
    })

    await page.evaluate(() => {
      ;(globalThis as typeof globalThis & { __oauthAttempt?: Promise<unknown> }).__oauthAttempt =
        window.electronAPI.invoke('calendar:connect', 'google').catch((error: unknown) => error)
    })

    await expect
      .poll(async () => {
        return await session.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { __oauthOpenExternal?: { count: number } })
              .__oauthOpenExternal?.count ?? 0
        )
      })
      .toBe(1)

    await page.evaluate(async () => {
      await window.electronAPI.invoke('calendar:cancel-connect')
      await (globalThis as typeof globalThis & { __oauthAttempt?: Promise<unknown> }).__oauthAttempt
    })

    await page.waitForTimeout(5_500)
    const updaterStatus = await page.evaluate(async () => {
      return (await window.electronAPI.invoke('updater:get-status')) as { state?: unknown }
    })
    expect(['idle', 'checking', 'available', 'downloading', 'downloaded', 'error']).toContain(
      updaterStatus.state
    )
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
  } finally {
    await session.cleanup()
  }
})
