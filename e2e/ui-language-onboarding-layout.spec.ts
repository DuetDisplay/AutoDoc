import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../src/shared/ui-language'
import { launchIsolatedE2EApp, setOllamaStatus } from './helpers/electron-app'
import { launchGithubStarApp } from './helpers/github-star'
import {
  expectCardLayout,
  expectTextWithin,
  revealVertically,
  setContentSize,
  setUi,
  settleLayout
} from './helpers/ui-layout'

const PASSES = [
  { width: 788, height: 540, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { width: 1280, height: 800, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { width: 788, height: 540, theme: 'dark' as const, languages: ['de' as UiLanguageCode] }
]
async function eachPass(
  app: ElectronApplication,
  page: Page,
  check: (language: UiLanguageCode, label: string) => Promise<void>
) {
  for (const pass of PASSES) {
    await setContentSize(app, page, pass.width, pass.height, 1)
    for (const language of pass.languages) {
      await setUi(page, language, pass.theme)
      await check(language, `${language}-${pass.width}x${pass.height}-${pass.theme}`)
      if (pass.width === 788 && ['de', 'el', 'fi'].includes(language))
        await page.screenshot({ path: test.info().outputPath(`${language}-${pass.theme}.png`) })
    }
  }
}

async function expectPickerBounds(page: Page) {
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expectTextWithin(list)
  expect(
    await list.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return (
        box.left >= 0 &&
        box.right <= innerWidth &&
        box.top >= 0 &&
        box.bottom <= innerHeight &&
        element.scrollWidth <= element.clientWidth + 1
      )
    })
  ).toBe(true)
}

test('first onboarding language screen and its picker fit all 27 UI languages', async () => {
  test.setTimeout(180_000)
  const fixture = await launchIsolatedE2EApp()
  const page = await fixture.electronApp.firstWindow()
  try {
    const card = page.getByTestId('ui-language-step')
    await expect(card).toBeVisible()
    await eachPass(fixture.electronApp, page, async (language, label) => {
      await expectCardLayout(card, `onboarding ${label}`)
      const picker = card.getByRole('button', {
        name: translate(language, 'uiLanguage.title'),
        exact: true
      })
      await picker.click()
      const list = page.getByRole('listbox')
      await expectPickerBounds(page)
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
    })
    await setUi(page, 'en', 'light')
    await card.getByRole('button', { name: 'App language' }).click()
    await page.getByRole('option', { name: 'Español', exact: true }).click()
    await expect(card.getByRole('heading')).toHaveText('Elige tu idioma')
    expect(await page.evaluate(() => window.electronAPI.invoke('prefs:get-ui-language'))).toBe('es')
  } finally {
    await fixture.cleanup()
  }
})
test('sidebar appearance switch fits long status rows in all UI languages and syncs with Settings', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('recording:status-changed', {
        isRecording: true,
        meetingId: 'sidebar-layout-fixture',
        startedAt: Date.now() - 10_000,
        sourceId: 'screen:fixture',
        sourceName: 'Layout fixture',
        recordingIntent: null,
        trackedMeetingSourceId: null,
        trackedMeetingSourceName: null,
        trackedMeetingProviderId: null
      })
    })
    await eachPass(electronApp, page, async (language, label) => {
      await setOllamaStatus(page, { phase: 'ready', percent: 100 })
      const sidebar = page.locator('aside')
      const control = sidebar.getByRole('switch')
      await revealVertically(control)
      await expectCardLayout(control, `sidebar switch ${label}`)
      await expectTextWithin(sidebar)
      await setOllamaStatus(page, {
        phase: 'error',
        percent: 0,
        failedStep: 'model_load',
        error: 'fixture'
      })
      await expect(
        sidebar.getByText(translate(language, 'nav.notesModelUnavailable'))
      ).toBeVisible()
      await expectCardLayout(control, `sidebar unavailable ${label}`)
      await expectTextWithin(sidebar)
    })
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('recording:status-changed', {
        isRecording: false,
        meetingId: null,
        startedAt: null,
        sourceId: null,
        sourceName: null,
        recordingIntent: null,
        trackedMeetingSourceId: null,
        trackedMeetingSourceName: null,
        trackedMeetingProviderId: null
      })
    })
    await setUi(page, 'en', 'light')
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    const control = page.locator('aside').getByRole('switch', { name: 'Dark mode' })
    await control.focus()
    await page.keyboard.press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const group = page.getByRole('group', { name: 'Appearance', exact: true })
    await expect(group.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await group.getByRole('button', { name: 'Light', exact: true }).click()
    await expect(control).toHaveAttribute('aria-checked', 'false')
    await control.click()
    await fixture.restart()
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(fixture.page.locator('aside').getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  } finally {
    await fixture.cleanup()
  }
})
test('upgrade popup fits every language and queues behind the meeting-language announcement', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({
    qualified: false,
    uiAppearanceAnnouncement: true,
    meetingLanguageAnnouncement: true
  })
  const { page, electronApp } = fixture
  try {
    const meeting = page.locator('dialog[data-announcement="meeting-language"]')
    await expect(meeting).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await meeting.getByRole('button', { name: 'Got it', exact: true }).click()
    const dialog = page.locator('dialog[data-announcement="ui-appearance"]')
    await expect(dialog).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await eachPass(electronApp, page, async (language, label) => {
      await expectCardLayout(dialog, `popup ${label}`)
      const box = await dialog.boundingBox()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight))
      await dialog
        .getByRole('button', { name: translate(language, 'uiLanguage.title'), exact: true })
        .click()
      await expectPickerBounds(page)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect(page.getByRole('listbox')).toHaveCount(0)
    })
    await setUi(page, 'en', 'light')
    await dialog.getByRole('switch').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await dialog.getByRole('button', { name: 'App language' }).click()
    await page.getByRole('option', { name: 'Deutsch', exact: true }).click()
    await expect(dialog.getByRole('heading')).toHaveText('AutoDoc spricht jetzt Ihre Sprache')
    // Native modal focus remains in the popup through keyboard traversal.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      )
    }
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    expect(
      await page.evaluate(() =>
        window.electronAPI.invoke('prefs:get-ui-appearance-announcement-pending')
      )
    ).toBe(false)
    await page.reload()
    await settleLayout(page)
    await expect(dialog).not.toBeVisible()
  } finally {
    await fixture.cleanup()
  }
})
