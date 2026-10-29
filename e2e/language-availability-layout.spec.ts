import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { translate } from '../src/shared/i18n'
import { MEETING_LANGUAGE_DEFINITIONS } from '../src/shared/meeting-language'
import {
  dateLocaleForUiLanguage,
  UI_LANGUAGE_CODES,
  type UiLanguageCode
} from '../src/shared/ui-language'
import {
  jumpToOnboardingStep,
  launchIsolatedE2EApp,
  setWhisperStatus
} from './helpers/electron-app'
import { launchUiFollowupApp } from './helpers/ui-followup-fixture'
import {
  expectCardLayout,
  expectTextWithin,
  revealVertically,
  setContentSize,
  setUi,
  settleLayout
} from './helpers/ui-layout'

// The app's BrowserWindow minimum is 800x600; the localized layout specs use the matching
// content area 788x540. 1280x800 is a typical window.
const MIN = { width: 788, height: 540 }
const TYPICAL = { width: 1280, height: 800 }
const SIZES = [MIN, TYPICAL]
// Languages with the longest translations plus CJK; screenshots are kept for the minimum size.
const SHOT_LANGUAGES: UiLanguageCode[] = ['en', 'de', 'el', 'bg', 'ja']
const SHOT_DIR = process.env.LANGUAGE_AVAILABILITY_SHOT_DIR

async function shot(page: Page, name: string, language: UiLanguageCode, minimum: boolean) {
  if (!minimum || !SHOT_LANGUAGES.includes(language)) return
  const dir = SHOT_DIR ?? test.info().outputPath('shots')
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}-${language}.png`) })
}

async function eachPass(
  app: ElectronApplication,
  page: Page,
  check: (language: UiLanguageCode, minimum: boolean, label: string) => Promise<void>
) {
  for (const size of SIZES)
    for (const language of UI_LANGUAGE_CODES) {
      await setContentSize(app, page, size.width, size.height, 1)
      await setUi(page, language, 'light')
      await check(language, size === MIN, `${language} ${size.width}x${size.height}`)
    }
}

/** The picker shows the language name in the viewer's UI language. */
function spanishIn(language: UiLanguageCode): string {
  return new Intl.DisplayNames([dateLocaleForUiLanguage(language)], { type: 'language' }).of('es')!
}

const LOCKED_SPANISH = {
  availability: 'locked',
  reason: 'Spanish needs a supported graphics card on this PC.',
  reasonCode: 'needs-supported-graphics-card',
  engineId: null,
  firstUseDownloadBytes: 0
}

test('meeting language picker explains a locked language in every UI language', async () => {
  test.setTimeout(900_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    await electronApp.evaluate(
      ({ ipcMain }, { locked, codes }) => {
        const handle = (channel: string, fn: () => unknown) => {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, fn)
        }
        handle('prefs:get-meeting-language-availability', () => ({
          restricted: false,
          availableLanguages: codes
        }))
        handle('whisper:get-meeting-language-states', () => ({ es: locked }))
      },
      { locked: LOCKED_SPANISH, codes: MEETING_LANGUAGE_DEFINITIONS.map((d) => d.code) }
    )
    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await setUi(page, 'en', 'light')
    await page.getByRole('heading', { name: translate('en', 'settings.title') }).waitFor()

    await eachPass(electronApp, page, async (language, minimum, label) => {
      const [before, after] = translate(language, 'meeting.languageAria', {
        language: '\u0001'
      }).split('\u0001')
      const hint = (after.trim() || before.trim()).trim()
      const trigger = page.locator(`button[aria-haspopup="listbox"][aria-label*="${hint}"]`)
      await revealVertically(trigger)
      await trigger.click()
      const listbox = page.getByRole('listbox', {
        name: translate(language, 'meeting.languageOptionsAria')
      })
      await expect(listbox).toBeVisible()
      const reason = translate(language, 'picker.reasonNeedsGraphicsCard', {
        language: spanishIn(language)
      })
      const option = listbox.getByRole('option').filter({ hasText: reason })
      await expect(option).toHaveCount(1)
      await expect(option).toHaveAttribute('aria-disabled', 'true')
      // The English sentence must never reach a non-English UI.
      if (language !== 'en')
        await expect(listbox.getByText('needs a supported graphics card')).toHaveCount(0)
      await option.scrollIntoViewIfNeeded()
      await settleLayout(page)
      await expectCardLayout(option, `locked option ${label}`)
      await expectTextWithin(option, listbox)
      await shot(page, 'picker-locked-reason', language, minimum)
      await page.keyboard.press('Escape')
      await expect(listbox).toHaveCount(0)
    })
  } finally {
    await f.cleanup()
  }
})

test('onboarding transcription step explains a locked language in every UI language', async () => {
  test.setTimeout(900_000)
  const failure = {
    phase: 'error' as const,
    percent: 0,
    error: 'whisper-turbo-cuda self-test failed',
    failedStep: 'downloading-model' as const
  }
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: { microphone: false, screen: false },
    whisper: { status: { phase: 'checking', percent: 0 }, retryStatuses: [failure, failure] }
  })
  try {
    const page = await app.electronApp.firstWindow()
    await app.electronApp.evaluate(({ ipcMain }, locked) => {
      const handle = (channel: string, fn: () => unknown) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, fn)
      }
      // Skip the meeting-language confirmation so step 7 opens the speech setup directly.
      handle('prefs:get-onboarding-language-confirmed', () => true)
      handle('prefs:get-meeting-language', () => 'es')
      handle('whisper:get-windows-meeting-language-availability', () => locked)
    }, LOCKED_SPANISH)
    await eachPass(app.electronApp, page, async (language, minimum, label) => {
      await jumpToOnboardingStep(page, 7)
      await setWhisperStatus(page, failure)
      const reason = translate(language, 'picker.reasonNeedsGraphicsCard', {
        language: spanishIn(language)
      })
      const heading = page.getByRole('heading', {
        name: translate(language, 'ui.thisLanguageIsnTAvailableOnThisPC'),
        level: 3
      })
      await expect(heading).toBeVisible({ timeout: 15_000 })
      const card = heading.locator('xpath=..')
      await expect(card.getByText(reason, { exact: true })).toBeVisible()
      if (language !== 'en')
        await expect(page.getByText('needs a supported graphics card')).toHaveCount(0)
      await settleLayout(page)
      await revealVertically(card)
      await expectCardLayout(card, `onboarding locked card ${label}`)
      // The same sentence also replaces the progress label above the card.
      const status = page.getByText(reason, { exact: true }).first()
      await expectTextWithin(status, status.locator('xpath=..'))
      await shot(page, 'onboarding-locked-reason', language, minimum)
    })
  } finally {
    await app.cleanup()
  }
})
