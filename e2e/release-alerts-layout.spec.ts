import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../src/shared/ui-language'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  jumpToOnboardingStep,
  launchIsolatedE2EApp,
  relaunchIsolatedE2EApp,
  setWhisperStatus
} from './helpers/electron-app'
import { launchUiFollowupApp, openUiMeeting, setUiOutcome } from './helpers/ui-followup-fixture'
import {
  expectCardLayout,
  expectTextWithin,
  revealVertically,
  setContentSize,
  setUi,
  settleLayout
} from './helpers/ui-layout'

// The app's BrowserWindow minimum is 800x600; the existing localized layout specs use the
// matching content area 788x540. 1280x800 is a typical window.
const MIN = { width: 788, height: 540 }
const TYPICAL = { width: 1280, height: 800 }
const PASSES = [
  { size: MIN, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { size: TYPICAL, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { size: MIN, theme: 'dark' as const, languages: ['de' as UiLanguageCode] }
]
// Longest translations of these strings (de, el, bg) plus CJK; screenshots are kept for the minimum size.
const SHOT_LANGUAGES: UiLanguageCode[] = ['en', 'de', 'el', 'bg', 'ja']
const SHOT_DIR = process.env.RELEASE_ALERTS_SHOT_DIR

async function shot(page: Page, name: string, language: UiLanguageCode, minimum: boolean) {
  if (!minimum || !SHOT_LANGUAGES.includes(language)) return
  const dir = SHOT_DIR ?? test.info().outputPath('shots')
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}-${language}.png`) })
}

/** Run `check` for every size/theme/language pass; `prepare` runs once per pass entry. */
async function eachPass(
  app: ElectronApplication,
  page: Page,
  check: (language: UiLanguageCode, minimum: boolean, label: string) => Promise<void>
) {
  for (const { size, theme, languages } of PASSES)
    for (const language of languages) {
      await setContentSize(app, page, size.width, size.height, 1)
      await setUi(page, language, theme)
      await check(language, size === MIN, `${language} ${theme} ${size.width}x${size.height}`)
    }
}

test('CPU fallback notice, popover and disk-full callouts fit in every UI language', async () => {
  test.setTimeout(900_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    // Stateful transcription handlers on top of the synthetic meeting fixture.
    await electronApp.evaluate(({ ipcMain }) => {
      const state = { status: 'complete', cpu: false, error: undefined as string | undefined }
      ;(globalThis as any).__releaseTx = state
      const handle = (channel: string, fn: () => unknown) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, fn)
      }
      handle('transcription:get-status', () => state.status)
      handle('transcription:get-progress', () =>
        state.status === 'transcribing' ? 0.42 : undefined
      )
      handle('transcription:get-error-code', () => state.error)
      handle('transcription:get-cpu-fallback', () => state.cpu)
    })
    const setTx = (patch: Record<string, unknown>) =>
      electronApp.evaluate((_e, p) => Object.assign((globalThis as any).__releaseTx, p), patch)
    const tab = (language: UiLanguageCode, key: 'meeting.notes' | 'meeting.transcript') =>
      page.getByRole('button', { name: translate(language, key), exact: true })
    const main = page.locator('main')

    // 1. CPU fallback notice + "Why?" popover.
    await setTx({ status: 'transcribing', cpu: true, error: undefined })
    await setUiOutcome(electronApp, { failureCode: '' })
    await openUiMeeting(page)
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const card = page.getByRole('status').filter({
        hasText: translate(language, 'ui.usingCPUForThisRecording')
      })
      await expect(card).toBeVisible()
      await expectCardLayout(card, `cpu notice ${label}`)
      await expectTextWithin(card, main)
      await shot(page, 'cpu-notice', language, minimum)

      const why = card.getByRole('button', {
        name: translate(language, 'ui.whyIsThisTakingLonger'),
        exact: true
      })
      await why.click()
      const popover = page.getByRole('dialog')
      await expect(popover).toBeVisible()
      await settleLayout(page)
      await expectCardLayout(popover, `cpu popover ${label}`)
      await expectTextWithin(popover, popover)
      const rect = await popover.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }
      })
      // Same containment bounds as the speaker-rename popover test (gutter and drag region).
      expect(rect.y, label).toBeGreaterThanOrEqual(59)
      expect(rect.bottom, label).toBeLessThanOrEqual(rect.h - 15)
      expect(rect.x, label).toBeGreaterThanOrEqual(15)
      expect(rect.right, label).toBeLessThanOrEqual(rect.w - 15)
      await shot(page, 'cpu-popover', language, minimum)
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
    })

    // 2. Transcription failed because the disk is full, Notes and Transcript tabs.
    await setTx({ status: 'failed', cpu: false, error: 'disk-full' })
    await openUiMeeting(page)
    await eachPass(electronApp, page, async (language, minimum, label) => {
      for (const key of ['meeting.notes', 'meeting.transcript'] as const) {
        await tab(language, key).click()
        const alert = main.getByRole('alert').filter({
          hasText: translate(language, 'ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')
        })
        await expect(alert).toBeVisible()
        await revealVertically(alert)
        await expectCardLayout(alert, `transcription disk-full ${key} ${label}`)
        await expectTextWithin(alert, main)
        await expect(
          alert.getByRole('button', {
            name: translate(language, 'ui.retryTranscription'),
            exact: true
          })
        ).toBeVisible()
        if (key === 'meeting.notes') await shot(page, 'transcription-disk-full', language, minimum)
      }
    })

    // 3. Notes failed because the disk is full.
    await setTx({ status: 'complete', error: undefined })
    await setUiOutcome(electronApp, { failureCode: 'disk-full' })
    await openUiMeeting(page)
    await eachPass(electronApp, page, async (language, minimum, label) => {
      for (const key of ['meeting.notes', 'meeting.transcript'] as const) {
        await tab(language, key).click()
        const alert = main.getByRole('alert').filter({
          hasText: translate(language, 'ui.notEnoughDiskSpaceFreeUpSpaceAndTryAgain')
        })
        if (key === 'meeting.transcript' && (await alert.count()) === 0) continue
        await expect(alert).toBeVisible()
        await revealVertically(alert)
        await expectCardLayout(alert, `notes disk-full ${key} ${label}`)
        await expectTextWithin(alert, main)
        await expect(
          alert.getByRole('button', { name: translate(language, 'ui.retryNotes'), exact: true })
        ).toBeVisible()
        if (key === 'meeting.notes') await shot(page, 'notes-disk-full', language, minimum)
      }
    })
  } finally {
    await f.cleanup()
  }
})

test('update disk-full banner and Settings card fit in every UI language', async () => {
  test.setTimeout(600_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    const sendStatus = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows())
          w.webContents.send('updater:status', {
            state: 'error',
            error: 'ENOSPC: no space left on device',
            errorKind: 'disk-full'
          })
      })
    const alertFor = (language: UiLanguageCode) =>
      page.getByRole('alert').filter({
        hasText: translate(language, 'ui.notEnoughSpaceToInstallTheUpdate')
      })

    // App-wide banner on a non-Settings route.
    await setUiOutcome(electronApp, { failureCode: '' })
    await openUiMeeting(page)
    await page.getByRole('button', { name: 'Transcript', exact: true }).waitFor()
    await sendStatus()
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const banner = alertFor(language)
      await expect(banner).toBeVisible()
      await expectCardLayout(banner, `update banner ${label}`)
      for (const key of ['ui.notNow', 'ui.tryAgain'] as const)
        await expect(
          banner.getByRole('button', { name: translate(language, key), exact: true })
        ).toBeVisible()
      await shot(page, 'update-banner', language, minimum)
    })

    // Card variant in Settings > About.
    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await setUi(page, 'en', 'light')
    await page.getByRole('heading', { name: translate('en', 'settings.title') }).waitFor()
    await sendStatus()
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const card = alertFor(language)
      await expect(card).toBeVisible()
      await revealVertically(card)
      await expectCardLayout(card, `update settings card ${label}`)
      await expect(
        card.getByRole('button', { name: translate(language, 'ui.tryAgain'), exact: true })
      ).toBeVisible()
      await shot(page, 'update-settings-card', language, minimum)
    })
  } finally {
    await f.cleanup()
  }
})

test('onboarding speech setup disk-full card fits in every UI language', async () => {
  test.setTimeout(600_000)
  const failure = {
    phase: 'error' as const,
    percent: 0,
    error: 'ENOSPC: no space left on device',
    errorKind: 'disk-full' as const,
    failedStep: 'downloading-model' as const
  }
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: { microphone: false, screen: false },
    whisper: { status: { phase: 'checking', percent: 0 }, retryStatuses: [failure, failure] }
  })
  try {
    const page = await app.electronApp.firstWindow()
    await app.electronApp.evaluate(({ ipcMain }) => {
      // Skip the meeting-language confirmation so step 7 opens the speech setup directly.
      ipcMain.removeHandler('prefs:get-onboarding-language-confirmed')
      ipcMain.handle('prefs:get-onboarding-language-confirmed', () => true)
    })
    await eachPass(app.electronApp, page, async (language, minimum, label) => {
      await jumpToOnboardingStep(page, 7)
      await setWhisperStatus(page, failure)
      const card = page.getByRole('alert').filter({
        hasText: translate(language, 'ui.notEnoughSpaceToSetUpTranscription')
      })
      await expect(card).toBeVisible({ timeout: 15_000 })
      await settleLayout(page)
      await revealVertically(card)
      await expectCardLayout(card, `onboarding disk-full ${label}`)
      await expect(
        card.getByRole('button', { name: translate(language, 'ui.tryAgain'), exact: true })
      ).toBeVisible()
      await shot(page, 'onboarding-disk-full', language, minimum)
    })
  } finally {
    await app.cleanup()
  }
})

test('audio-only reminder banner fits in every UI language', async () => {
  test.setTimeout(600_000)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-release-alerts-'))
  const app = await relaunchIsolatedE2EApp(
    userDataDir,
    { platform: 'darwin', permissions: { microphone: true, screen: true } },
    {
      AUTODOC_E2E_FFMPEG_PATH: path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
      AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1'
    }
  )
  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await setContentSize(app.electronApp, page, TYPICAL.width, TYPICAL.height, 1)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await page.evaluate(() => {
      // Fast-forward only the 5 minute audio-only reminder timer.
      const real = window.setTimeout.bind(window)
      ;(window as any).setTimeout = (fn: any, ms?: number, ...a: any[]) =>
        real(fn, ms === 300000 ? 1500 : ms, ...a)
      // Track video tracks so the test can end them like a vanished capture source.
      const w = window as any
      w.__vt = []
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await gum(c)
        stream.getVideoTracks().forEach((t) => w.__vt.push(t))
        return stream
      }
    })
    await page.getByRole('button', { name: /^Record$/ }).click()
    await page.locator('button').filter({ hasText: 'E2E Display' }).first().click()
    await expect(page.getByRole('button', { name: /^Stop Recording$/ })).toBeVisible()
    const banner = page.getByRole('alert').filter({ hasText: 'Recording audio only' })
    for (let i = 0; i < 12 && !(await banner.isVisible()); i++) {
      await page.evaluate(() => {
        const w = window as any
        for (const t of w.__vt) {
          if (t.__killed) continue
          t.__killed = true
          t.stop()
          t.dispatchEvent(new Event('ended'))
        }
      })
      await page.waitForTimeout(2500)
    }
    await expect(banner).toBeVisible({ timeout: 20_000 })
    // The reminder stays up while the UI language, theme and window size change.
    await eachPass(app.electronApp, page, async (language, minimum, label) => {
      const localized = page
        .getByRole('alert')
        .filter({ hasText: translate(language, 'ui.recordingAudioOnly') })
      await expect(localized).toBeVisible()
      await expectCardLayout(localized, `audio-only reminder ${label}`)
      for (const key of [
        'recording.audioOnlyReminderKeep',
        'recording.audioOnlyReminderStop'
      ] as const)
        await expect(
          localized.getByRole('button', { name: translate(language, key), exact: true })
        ).toBeVisible()
      await shot(page, 'audio-only-reminder', language, minimum)
    })
    await setUi(page, 'en', 'light')
    await page.getByRole('button', { name: /^Stop Recording$/ }).click()
  } finally {
    await app.cleanup()
  }
})
