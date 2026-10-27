import { test, expect } from '@playwright/test'
import { launchGithubStarApp, STAR_MEETING_ID } from './helpers/github-star'
import { UI_LANGUAGE_CODES, dateLocaleForUiLanguage } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'

for (const width of [800, 1000]) {
  test(`live title, menu, search error and picker localization in all languages and themes at ${width}px`, async () => {
    test.setTimeout(180_000)
    const fixture = await launchGithubStarApp({ qualified: false })
    const { page, electronApp } = fixture
    try {
      const win = await electronApp.browserWindow(page)
      await win.evaluate((w, width) => w.setContentSize(width, 720), width)
      await page.setViewportSize({ width, height: 720 })
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('search:query')
        ipcMain.handle('search:query', () => {
          throw new Error('Synthetic search failure')
        })
      })
      for (const theme of ['light', 'dark'])
        for (const language of UI_LANGUAGE_CODES) {
          const t = (key: Parameters<typeof translate>[1]) => translate(language, key)
          await page.evaluate(
            async ({ language, theme }) => {
              await window.electronAPI.invoke('prefs:set-ui-language', language)
              await window.electronAPI.invoke('prefs:set-appearance', theme as 'light' | 'dark')
              location.hash = '#/recordings'
            },
            { language, theme }
          )
          const detail = await page.evaluate(
            (id) => window.electronAPI.invoke('recording:get-detail', id),
            STAR_MEETING_ID
          )
          const suffix = new Intl.DateTimeFormat(dateLocaleForUiLanguage(language), {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          }).format(detail!.date)
          const title = `Product planning — ${suffix}`
          const card = page.getByRole('link', { name: title, exact: true })
          await expect(card).toBeVisible()
          await card.focus()
          await page.keyboard.press('Enter')
          await expect(page.getByText(title, { exact: true })).toBeVisible()
          const menus = await electronApp.evaluate(({ Menu }) => {
            const values: Record<string, string> = {}
            const visit = (items: Electron.MenuItem[]) => {
              for (const item of items) {
                if (item.role) values[item.role.toLowerCase()] = item.label
                if (item.submenu) visit(item.submenu.items)
              }
            }
            visit(Menu.getApplicationMenu()!.items)
            return values
          })
          expect(menus.filemenu).toBe(t('menu.file'))
          expect(menus.editmenu).toBe(t('menu.edit'))
          expect(menus.viewmenu).toBe(t('menu.view'))
          expect(menus.undo).toBe(t('menu.undo'))
          expect(menus.paste).toBe(t('menu.paste'))
          await page.evaluate(() => {
            location.hash = '#/search'
          })
          await page.getByRole('textbox').fill('Synthetic rejected query')
          await expect(page.getByRole('alert')).toContainText(t('search.failed'))
          const alert = await page.getByRole('alert').boundingBox()
          expect(alert!.x).toBeGreaterThanOrEqual(200)
          expect(alert!.x + alert!.width).toBeLessThanOrEqual(width)
          await page.screenshot({
            path: test.info().outputPath(`${language}-${theme}-search-error.png`)
          })
          await page.evaluate(() => {
            location.hash = '#/'
          })
          await page.getByRole('button', { name: t('recording.record'), exact: true }).click()
          await expect(
            page.getByRole('dialog', { name: t('recording.selectWindowToRecord') })
          ).toBeVisible()
          const next =
            UI_LANGUAGE_CODES[(UI_LANGUAGE_CODES.indexOf(language) + 1) % UI_LANGUAGE_CODES.length]
          await page.evaluate(
            (next) => window.electronAPI.invoke('prefs:set-ui-language', next),
            next
          )
          await expect(
            page.getByRole('dialog', { name: translate(next, 'recording.selectWindowToRecord') })
          ).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
          await expect(
            page.getByRole('button', { name: translate(next, 'recording.record'), exact: true })
          ).toBeFocused()
        }
    } finally {
      await fixture.cleanup()
    }
  })
}
