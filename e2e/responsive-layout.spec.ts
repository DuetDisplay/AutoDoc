import { test, expect, type Page } from '@playwright/test'
import { launchGithubStarApp, STAR_MEETING_ID } from './helpers/github-star'
import { setDetectionState, pollDetection } from './helpers/electron-app'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'

async function settleNotification(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await expect(page.locator('.toast')).toHaveClass(theme === 'dark' ? /dark/ : /^toast$/)
  await page.locator('.toast').evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined))
    )
  })
}

test('native meeting prompts keep actions beside readable text in every language and theme', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    const pending = electronApp.waitForEvent('window')
    await setDetectionState(page, { providerActiveIds: ['us.zoom.xos'] })
    await pollDetection(page)
    const notification = await pending
    await expect(notification.locator('#primary-action')).toBeVisible()
    for (const theme of ['light', 'dark'] as const)
      for (const language of UI_LANGUAGE_CODES) {
        await page.evaluate(
          async ({ language, theme }) => {
            await window.electronAPI.invoke('prefs:set-ui-language', language)
            await window.electronAPI.invoke('prefs:set-appearance', theme)
          },
          { language, theme }
        )
        await expect(notification.locator('#primary-action')).toHaveText(
          translate(language, 'recording.startNotes')
        )
        await settleNotification(notification, theme)
        await expect
          .poll(
            () =>
              notification.evaluate(() => {
                const text = document.querySelector('.text')!.getBoundingClientRect()
                const actions = document.querySelector('.actions')!.getBoundingClientRect()
                return (
                  text.width >= 140 &&
                  actions.left >= text.right &&
                  actions.top < text.bottom &&
                  actions.bottom <= innerHeight
                )
              }),
            { message: `${language} ${theme}: compact notification with readable text` }
          )
          .toBe(true)
        await notification.screenshot({
          path: test.info().outputPath(`meeting-${language}-${theme}.png`)
        })
      }
  } finally {
    await fixture.cleanup()
  }
})

test('long native meeting titles have a bounded preview and retain the full title', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  const title =
    'Product roadmap, engineering priorities and release readiness for the next quarter — '
      .repeat(5)
      .trim()
  try {
    const pending = electronApp.waitForEvent('window')
    await page.evaluate(
      (title) => window.electronAPI.invoke('e2e:trigger-notes-ready-notification', { title }),
      title
    )
    const notification = await pending
    const preview = notification.locator('.meeting-title')
    for (const theme of ['light', 'dark'] as const)
      for (const language of UI_LANGUAGE_CODES) {
        await page.evaluate(
          async ({ language, theme }) => {
            await window.electronAPI.invoke('prefs:set-ui-language', language)
            await window.electronAPI.invoke('prefs:set-appearance', theme)
          },
          { language, theme }
        )
        await expect(notification.locator('.subtitle')).toHaveText(
          translate(language, 'notesReady.body')
        )
        await settleNotification(notification, theme)
        await expect(preview).toHaveText(title)
        await expect(preview).toHaveAttribute('title', title)
        expect(
          await preview.evaluate(
            (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)
          )
        ).toBeLessThanOrEqual(2.1)
        await expect(notification.locator('#primary-action')).toBeVisible()
        expect(
          await notification
            .locator('.title')
            .evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
        ).toBe(true)
        await expect
          .poll(() =>
            notification.evaluate(() => {
              const actions = document.querySelector('.actions')!.getBoundingClientRect()
              const body = document.querySelector('.subtitle')!.getBoundingClientRect()
              return (
                actions.bottom <= innerHeight && body.bottom <= innerHeight && innerHeight <= 220
              )
            })
          )
          .toBe(true)
        await notification.screenshot({
          path: test.info().outputPath(`long-notes-${language}-${theme}.png`)
        })
      }
  } finally {
    await fixture.cleanup()
  }
})

test('stacked banners leave page content and controls reachable through 200 percent zoom', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    const native = await electronApp.browserWindow(page)
    await native.evaluate((w) => w.setContentSize(800, 600))
    await page.setViewportSize({ width: 800, height: 600 })
    for (const scale of [1, 1.25, 1.5, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await native.evaluate((w, scale) => w.webContents.setZoomFactor(scale), scale)
          await page.evaluate(
            async ({ language, theme }) => {
              await window.electronAPI.invoke('prefs:set-ui-language', language)
              await window.electronAPI.invoke('prefs:set-appearance', theme)
            },
            { language, theme }
          )
          await page.reload()
          const heading = page.getByRole('heading', {
            name: translate(language, 'upcoming.title'),
            exact: true
          })
          await expect(heading).toBeVisible()
          await electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
              .find((w) => w.isFocusable())!
              .webContents.send('updater:status', {
                state: 'downloaded',
                version: '1.3.2',
                installBlockedReason:
                  'AutoDoc is processing your meeting. Restart when it finishes.'
              })
          })
          const update = page.getByText(translate(language, 'update.processingBeforeRestart'), {
            exact: true
          })
          await expect(update).toBeVisible()
          expect(
            await update.evaluate((el) => el.getBoundingClientRect().width),
            `${scale} ${language}: readable banner text width`
          ).toBeGreaterThan(120)
          await heading.scrollIntoViewIfNeeded()
          await expect(heading).toBeInViewport()
          const record = page.getByRole('button', {
            name: translate(language, 'recording.record'),
            exact: true
          })
          await record.scrollIntoViewIfNeeded()
          await expect(record).toBeInViewport()
          await record.click()
          await expect(page.getByRole('dialog')).toBeVisible()
          await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 1 })
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
          await page.screenshot({
            path: test.info().outputPath(`stacked-${scale}-${language}-${theme}.png`)
          })
        }
  } finally {
    await fixture.cleanup()
  }
})

test('meeting badges preserve readable titles and the full title can be edited by keyboard at high zoom', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    const native = await electronApp.browserWindow(page)
    await native.evaluate((w) => w.setContentSize(800, 600))
    await page.setViewportSize({ width: 800, height: 600 })
    for (const scale of [1.5, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await native.evaluate((w, scale) => w.webContents.setZoomFactor(scale), scale)
          await page.evaluate(
            async ({ language, theme }) => {
              await window.electronAPI.invoke('prefs:set-ui-language', language)
              await window.electronAPI.invoke('prefs:set-appearance', theme)
              location.hash = '#/recordings'
            },
            { language, theme }
          )
          const detail = await page.evaluate(
            (id) => window.electronAPI.invoke('recording:get-detail', id),
            STAR_MEETING_ID
          )
          const card = page.getByRole('link', { name: detail!.title, exact: true })
          await expect(card).toBeVisible()
          expect(await card.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(120)
          const title = (await card.getAttribute('aria-label'))!
          await card.click()
          const edit = page.getByRole('button', { name: title, exact: true })
          await edit.focus()
          await page.keyboard.press('Enter')
          const editor = page.getByRole('textbox').first()
          await expect(editor).toBeVisible()
          await expect(editor).toHaveValue(title)
          await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
          await expect(editor).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(edit).toBeVisible()
          await page.screenshot({
            path: test.info().outputPath(`title-${scale}-${language}-${theme}.png`)
          })
        }
  } finally {
    await fixture.cleanup()
  }
})

test('language and export popovers stay visible and usable at high zoom in every language', async () => {
  test.setTimeout(240_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  const fits = async (selector: string) => {
    await expect
      .poll(() =>
        page.locator(selector).evaluate((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
          )
        })
      )
      .toBe(true)
  }
  try {
    const native = await electronApp.browserWindow(page)
    await native.evaluate((w) => w.setContentSize(800, 600))
    await page.setViewportSize({ width: 800, height: 600 })
    for (const scale of [1.5, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await native.evaluate((w, scale) => w.webContents.setZoomFactor(scale), scale)
          await page.evaluate(
            async ({ language, theme }) => {
              await window.electronAPI.invoke('prefs:set-ui-language', language)
              await window.electronAPI.invoke('prefs:set-appearance', theme)
              location.hash = '#/settings'
            },
            { language, theme }
          )
          await expect(page.locator('html')).toHaveAttribute('lang', language)
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
          await page.evaluate(() => document.fonts.ready)
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              )
          )
          for (const control of await page.locator('aside a, aside button').all()) {
            if (!(await control.isVisible())) continue
            await control.scrollIntoViewIfNeeded()
            // Fractional zoom rounds scroll positions to physical pixels.
            await expect(control).toBeInViewport({ ratio: 0.99 })
            expect(
              await control.evaluate((el) => {
                const rect = el.getBoundingClientRect()
                return rect.top >= 51 && rect.bottom <= innerHeight + 1
              })
            ).toBe(true)
          }
          await page.locator('aside > div:last-child').evaluate((el) => {
            el.scrollTop = 0
          })
          for (const index of [0, 1]) {
            const trigger = page.locator('button[aria-haspopup="listbox"]').nth(index)
            await trigger.click()
            await expect(page.getByRole('listbox')).toBeVisible()
            await fits('[role="listbox"]')
            // The popup must also escape ancestor clipping, not merely fit the viewport.
            const popup = page.getByRole('listbox')
            expect(await popup.evaluate((el) => el.parentElement === document.body)).toBe(true)
            await page.keyboard.press('End')
            await expect(page.getByRole('option').last()).toBeInViewport()
            await page.screenshot({
              path: test.info().outputPath(`language-${index}-${scale}-${language}-${theme}.png`)
            })
            await page.keyboard.press('Escape')
            await expect(page.getByRole('listbox')).toHaveCount(0)
            await expect(trigger).toBeFocused()
          }
          await page.evaluate((id) => {
            location.hash = `#/recordings/${id}`
          }, STAR_MEETING_ID)
          await page
            .getByRole('button', { name: translate(language, 'ui.export'), exact: true })
            .click()
          await expect(
            page.getByRole('dialog', { name: translate(language, 'ui.exportNotes'), exact: true })
          ).toBeVisible()
          await fits('[role="dialog"]')
          await page.screenshot({
            path: test.info().outputPath(`export-${scale}-${language}-${theme}.png`)
          })
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        }
  } finally {
    await fixture.cleanup()
  }
})

test('unbroken transcript content wraps inside its column at normal and increased zoom', async () => {
  test.setTimeout(90_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  const text = `https://example.test/${'ReleaseIdentifierWithoutSpaces'.repeat(20)}`
  try {
    await electronApp.evaluate(
      ({ ipcMain }, { text, meetingId }) => {
        ipcMain.removeHandler('transcription:get-transcript')
        ipcMain.handle('transcription:get-transcript', () => [
          {
            id: 'wrap',
            meetingId,
            speaker: 'speaker_1',
            text,
            startMs: 0,
            endMs: 10000,
            confidence: 1
          }
        ])
      },
      { text, meetingId: STAR_MEETING_ID }
    )
    const native = await electronApp.browserWindow(page)
    await native.evaluate((w) => w.setContentSize(800, 600))
    for (const scale of [1, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of ['en', 'zh-Hans', 'ko'] as const) {
          await native.evaluate((w, scale) => w.webContents.setZoomFactor(scale), scale)
          await page.evaluate(
            async ({ language, theme, id }) => {
              await window.electronAPI.invoke('prefs:set-ui-language', language)
              await window.electronAPI.invoke('prefs:set-appearance', theme)
              location.hash = `#/recordings/${id}`
            },
            { language, theme, id: STAR_MEETING_ID }
          )
          await page
            .getByRole('button', { name: translate(language, 'meeting.transcript'), exact: true })
            .click()
          const content = page.locator('p').filter({ hasText: text })
          await expect(content).toHaveText(text)
          await content.scrollIntoViewIfNeeded()
          expect(
            await content.evaluate((element) => {
              const bounds = element.getBoundingClientRect()
              const range = document.createRange()
              range.selectNodeContents(element)
              return (
                bounds.left >= 0 &&
                bounds.right <= innerWidth + 1 &&
                [...range.getClientRects()].every(
                  (rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
                )
              )
            }),
            `${language} ${theme} ${scale}: full transcript text wraps`
          ).toBe(true)
          await page.screenshot({
            path: test.info().outputPath(`transcript-wrap-${language}-${theme}-${scale}.png`)
          })
        }
  } finally {
    await fixture.cleanup()
  }
})
