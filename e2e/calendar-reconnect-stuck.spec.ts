import { expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { completeOnboarding, launchRealSetupApp } from './helpers/electron-app'

/**
 * Regression coverage for: "Connect Google/Microsoft calendar stays broken after
 * the user closes the OAuth tab."
 *
 * Reported steps:
 *   1. Press "Connect Google Calendar" / "Connect Microsoft Outlook" and get
 *      redirected to the provider OAuth page.
 *   2. Close that browser tab without finishing.
 *   3. Press the button again -> "We couldn't connect <provider> ..." and from then
 *      on EVERY press (onboarding, homepage banner, settings) shows that message.
 *
 * Root cause: an abandoned attempt left `CalendarManager.connecting` stuck `true`
 * while `provider.connect()` waited on the loopback callback, so later attempts were
 * rejected with "Another calendar connection is already in progress".
 *
 * Fix under test:
 *   - The main process now supersedes an in-flight attempt when a new connect starts
 *     (and awaits the loopback server teardown so the OAuth port can rebind).
 *   - A shared renderer hook cancels the pending attempt when the window regains
 *     focus (the user returned without finishing).
 *
 * These tests use the real calendar IPC path (real-setup launch, NOT the E2E
 * fixtures, which always succeed). `shell.openExternal` is stubbed so no real
 * browser opens; the never-arriving callback is exactly the "user closed the tab"
 * condition.
 */

const FAKE_AUTH_WORKER_URL = 'http://127.0.0.1:59999'

interface RegressionNote {
  issue: string
  evidence: string[]
}

async function attachRegressionNote(testInfo: TestInfo, note: RegressionNote): Promise<void> {
  console.info(`[calendar-reconnect-regression] ${JSON.stringify(note)}`)
  await testInfo.attach(`${note.issue}-regression-note`, {
    body: JSON.stringify(note, null, 2),
    contentType: 'application/json'
  })
}

interface OpenExternalState {
  count: number
  urls: string[]
}

/** Replace shell.openExternal so we never pop a real browser tab during the test. */
async function stubOpenExternal(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => {
    const state: OpenExternalState = { count: 0, urls: [] }
    ;(globalThis as unknown as { __openExternalCalls: OpenExternalState }).__openExternalCalls =
      state
    shell.openExternal = async (url: string): Promise<void> => {
      state.count += 1
      state.urls.push(url)
    }
  })
}

async function getOpenExternalState(electronApp: ElectronApplication): Promise<OpenExternalState> {
  return await electronApp.evaluate(
    () =>
      (globalThis as unknown as { __openExternalCalls?: OpenExternalState }).__openExternalCalls ?? {
        count: 0,
        urls: []
      }
  )
}

const CONNECT_BUTTON = {
  google: /connect google calendar/i,
  microsoft: /connect microsoft outlook/i
} as const

test.describe('Calendar reconnect recovers after the OAuth tab is closed', () => {
  test('AD-79 a new connect supersedes an abandoned attempt instead of getting stuck', async ({}, testInfo) => {
    test.setTimeout(120_000)
    const evidence: string[] = []

    const app = await launchRealSetupApp({
      AUTODOC_AUTH_WORKER_URL: FAKE_AUTH_WORKER_URL,
      AUTODOC_SKIP_INSTALL_POLICY: '1'
    })
    const { electronApp } = app

    try {
      const page: Page = await electronApp.firstWindow()
      await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible({ timeout: 30_000 })

      await stubOpenExternal(electronApp)

      // First attempt: fire-and-forget. It hangs forever (the loopback callback
      // never arrives, just like a closed tab).
      await page.evaluate(() => {
        ;(globalThis as unknown as { __c1: Promise<unknown> }).__c1 = window.electronAPI
          .invoke('calendar:connect', 'google')
          .then(
            () => 'resolved',
            (err: unknown) => (err instanceof Error ? err.message : String(err))
          )
      })
      await expect
        .poll(async () => (await getOpenExternalState(electronApp)).count, { timeout: 10_000 })
        .toBe(1)
      evidence.push('First calendar:connect launched the OAuth redirect and is awaiting a callback.')

      // Second attempt from a different surface/provider. With the fix this is NOT
      // rejected with "already in progress" — it supersedes the abandoned attempt
      // and launches a fresh OAuth redirect.
      await page.evaluate(() => {
        ;(globalThis as unknown as { __c2: Promise<unknown> }).__c2 = window.electronAPI
          .invoke('calendar:connect', 'microsoft')
          .then(
            () => 'resolved',
            (err: unknown) => (err instanceof Error ? err.message : String(err))
          )
      })

      // The retry was allowed to start a brand new OAuth flow (count goes to 2).
      await expect
        .poll(async () => (await getOpenExternalState(electronApp)).count, { timeout: 10_000 })
        .toBe(2)
      evidence.push('Retry launched a fresh OAuth redirect (openExternal called twice).')

      // The superseded first attempt settles as cancelled, not "already in progress".
      const firstOutcome = (await page.evaluate(
        () => (globalThis as unknown as { __c1: Promise<unknown> }).__c1
      )) as string
      evidence.push(`First (abandoned) attempt outcome: ${firstOutcome}`)
      expect(firstOutcome).toMatch(/cancelled/i)
      expect(firstOutcome).not.toMatch(/already in progress/i)

      await attachRegressionNote(testInfo, { issue: 'AD-79', evidence })
    } finally {
      await app.cleanup()
    }
  })

  test('AD-79 homepage banner: connect recovers after returning from an abandoned OAuth tab', async ({}, testInfo) => {
    test.setTimeout(120_000)
    const evidence: string[] = []

    const app = await launchRealSetupApp({
      AUTODOC_AUTH_WORKER_URL: FAKE_AUTH_WORKER_URL,
      AUTODOC_SKIP_INSTALL_POLICY: '1'
    })
    const { electronApp } = app

    try {
      const page: Page = await electronApp.firstWindow()
      await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible({ timeout: 30_000 })

      await stubOpenExternal(electronApp)
      await completeOnboarding(page)

      // Environmental guard: the banner only renders when no calendar is connected.
      const existingAccounts = (await page.evaluate(
        async () => (await window.electronAPI.invoke('calendar:get-accounts')) as unknown[]
      )) as unknown[]
      test.skip(
        existingAccounts.length > 0,
        'A calendar account is already connected in this profile, so the unconnected "Connect" banner is not shown. The IPC-level regression test still proves the fix.'
      )

      const connectButton = page.getByRole('button', { name: CONNECT_BUTTON.google })
      await expect(connectButton).toBeVisible({ timeout: 20_000 })

      // Step 1 + 2: press connect -> get "redirected" -> abandon the tab.
      await connectButton.click()
      await expect(page.getByRole('button', { name: /connecting/i })).toBeVisible({
        timeout: 10_000
      })
      await expect
        .poll(async () => (await getOpenExternalState(electronApp)).count, { timeout: 10_000 })
        .toBe(1)
      evidence.push('First click launched the OAuth redirect.')

      // The user closes the OAuth tab and returns to the app — fresh render.
      await page.reload()

      // Step 3: press the button again. With the fix this supersedes the abandoned
      // attempt and starts a new OAuth flow rather than showing the stuck error.
      const connectAgain = page.getByRole('button', { name: CONNECT_BUTTON.google })
      await expect(connectAgain).toBeVisible({ timeout: 20_000 })
      await connectAgain.click()

      await expect
        .poll(async () => (await getOpenExternalState(electronApp)).count, { timeout: 10_000 })
        .toBe(2)
      evidence.push('Second click launched a fresh OAuth redirect (no stuck state).')

      // The "We couldn't connect ..." error must NOT appear.
      await expect(page.getByRole('button', { name: /connecting/i })).toBeVisible({
        timeout: 10_000
      })
      await expect(page.getByRole('alert')).toBeHidden()
      evidence.push('No "We couldn\'t connect" error banner appeared on the retry.')

      await attachRegressionNote(testInfo, { issue: 'AD-79', evidence })
    } finally {
      await app.cleanup()
    }
  })
})
