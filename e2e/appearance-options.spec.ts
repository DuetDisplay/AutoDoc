import { expect, test } from '@playwright/test'
import { launchGithubStarApp } from './helpers/github-star'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'

test('only Light and Dark are offered and fit every supported language at minimum width', async () => {
  test.setTimeout(120_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    const win = await electronApp.browserWindow(page)
    await win.evaluate((w) => w.setContentSize(800, 720))
    await page.setViewportSize({ width: 800, height: 720 })
    await page.addStyleTag({
      content: '*,*::before,*::after { transition: none !important; animation: none !important }'
    })
    for (const language of UI_LANGUAGE_CODES) {
      await page.evaluate(async (next) => {
        await window.electronAPI.invoke('prefs:set-ui-language', next)
        location.hash = '#/settings'
      }, language)
      const group = page.getByRole('group', {
        name: translate(language, 'appearance.title'),
        exact: true
      })
      await expect(group.getByRole('button')).toHaveCount(2)
      await expect(
        page
          .getByRole('main')
          .getByText(translate(language, 'appearance.description'), { exact: true })
      ).toBeVisible()
      for (const mode of ['light', 'dark'] as const) {
        const button = group.getByRole('button', {
          name: translate(language, `appearance.${mode}`),
          exact: true
        })
        await button.click()
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        const geometry = await group.evaluate((element) => {
          const row = element.parentElement!
          return [row, ...row.querySelectorAll<HTMLElement>('p, button')].every((item) => {
            const rect = item.getBoundingClientRect()
            return (
              rect.left >= 200 &&
              rect.right <= innerWidth &&
              item.scrollWidth <= item.clientWidth + 1 &&
              item.scrollHeight <= item.clientHeight + 1
            )
          })
        })
        expect(geometry, `${language} ${mode}`).toBe(true)
        await page.screenshot({
          path: test.info().outputPath(`${language}-${mode}-appearance-options.png`)
        })
      }
    }
  } finally {
    await fixture.cleanup()
  }
})
