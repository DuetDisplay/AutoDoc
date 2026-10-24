import { writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding, launchIsolatedE2EApp } from './helpers/electron-app'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../src/shared/ui-language'

async function setLanguage(page: Page, language: UiLanguageCode): Promise<void> {
  await page.evaluate((next) => window.electronAPI.invoke('prefs:set-ui-language', next), language)
  await expect(page.locator('html')).toHaveAttribute('lang', language)
}

test('appearance follows system settings, persists, and the language picker works by keyboard', async () => {
  const fixture = await launchIsolatedE2EApp({ permissions: { microphone: true, screen: true } })
  try {
    const page = await fixture.electronApp.firstWindow()
    await completeOnboarding(page)
    await page.setViewportSize({ width: 800, height: 600 })
    await page.addStyleTag({
      content: '*,*::before,*::after { animation: none !important; transition: none !important }'
    })
    for (const system of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: system })
      for (const mode of ['auto', 'light', 'dark'] as const) {
        await page.evaluate((next) => window.electronAPI.invoke('prefs:set-appearance', next), mode)
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          mode === 'auto' ? system : mode
        )
        await page.screenshot({
          path: test.info().outputPath(`appearance-${mode}-system-${system}.png`)
        })
      }
    }
    await setLanguage(page, 'de')
    await page.evaluate(() => {
      window.location.hash = '#/settings'
    })
    const watermark = page.getByRole('button', {
      name: translate('de', 'settings.watermarkAria'),
      exact: true
    })
    const controlContrasts: Array<Record<string, unknown>> = []
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((next) => window.electronAPI.invoke('prefs:set-appearance', next), theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      for (const enabled of [false, true]) {
        if (((await watermark.getAttribute('aria-pressed')) === 'true') !== enabled)
          await watermark.click()
        await expect(watermark).toHaveAttribute('aria-pressed', String(enabled))
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        )
        const contrast = await watermark.evaluate((element) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d', { willReadFrequently: true })!
          const rgba = (color: string) => {
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
            return [r, g, b, a / 255]
          }
          const composite = (front: number[], back: number[]) =>
            [0, 1, 2].map((i) => front[i] * front[3] + back[i] * (1 - front[3])).concat(1)
          const luminance = (color: number[]) =>
            color
              .slice(0, 3)
              .map((x) => {
                x /= 255
                return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
              })
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
          const ratio = (a: number[], b: number[]) => {
            const x = luminance(a),
              y = luminance(b)
            return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
          }
          const layers: number[][] = []
          let parent = element.parentElement
          while (parent) {
            layers.push(rgba(getComputedStyle(parent).backgroundColor))
            parent = parent.parentElement
          }
          const adjacent = layers
            .reverse()
            .reduce((back, front) => composite(front, back), [250, 250, 247, 1])
          const track = composite(rgba(getComputedStyle(element).backgroundColor), adjacent)
          const thumb = composite(
            rgba(getComputedStyle(element.firstElementChild!).backgroundColor),
            track
          )
          return { thumb: ratio(track, thumb), background: ratio(track, adjacent), track, adjacent }
        })
        controlContrasts.push({ theme, enabled, ...contrast })
        expect(contrast.thumb, `${theme} ${enabled} thumb`).toBeGreaterThanOrEqual(3)
        expect(contrast.background, `${theme} ${enabled} track`).toBeGreaterThanOrEqual(3)
        await page.screenshot({
          path: test.info().outputPath(`toggle-${theme}-${enabled ? 'on' : 'off'}.png`)
        })
      }
    }
    const contrastPath = test.info().outputPath('toggle-contrast.json')
    writeFileSync(contrastPath, JSON.stringify(controlContrasts, null, 2))
    await test
      .info()
      .attach('toggle-contrast', { path: contrastPath, contentType: 'application/json' })
    const trigger = page.getByRole('button', {
      name: translate('de', 'uiLanguage.title'),
      exact: true
    })
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox')).toBeVisible()
    await expect(page.getByRole('option', { selected: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(trigger).toBeFocused()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  } finally {
    await fixture.cleanup()
  }
})

test('native notes status fits every language, and an existing notification follows language and theme', async () => {
  test.setTimeout(180_000)
  const fixture = await launchIsolatedE2EApp({ permissions: { microphone: true, screen: true } })
  try {
    const page = await fixture.electronApp.firstWindow()
    await completeOnboarding(page)
    for (const language of UI_LANGUAGE_CODES) {
      await setLanguage(page, language)
      await page.evaluate(() => window.electronAPI.invoke('prefs:set-appearance', 'light'))
      const notificationEvent = fixture.electronApp.waitForEvent('window')
      await page.evaluate(() =>
        window.electronAPI.invoke('e2e:trigger-notes-ready-notification', {
          title: 'Synthetic long meeting title '.repeat(12)
        })
      )
      const notification = await notificationEvent
      await expect(notification.locator('.subtitle')).toHaveText(
        translate(language, 'notesReady.body')
      )
      await expect(notification.locator('html')).toHaveAttribute('lang', language)
      const statusFits = () =>
        notification.evaluate(() => {
          const status = document.querySelector('.subtitle') as HTMLElement
          const actions = document.querySelector('.actions')!.getBoundingClientRect()
          return (
            status.scrollHeight <= status.clientHeight &&
            actions.bottom <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth
          )
        })
      await expect.poll(statusFits, { message: language }).toBe(true)
      await page.evaluate(() => window.electronAPI.invoke('prefs:set-appearance', 'dark'))
      await expect(notification.locator('.toast')).toHaveClass(/dark/)
      await expect.poll(statusFits, { message: `${language} dark` }).toBe(true)
      await setLanguage(page, 'ja')
      await expect(notification.locator('.subtitle')).toHaveText(translate('ja', 'notesReady.body'))
      await expect(notification.locator('html')).toHaveAttribute('lang', 'ja')
      await expect.poll(statusFits).toBe(true)
      const native = await fixture.electronApp.browserWindow(notification)
      await native.evaluate((win) => win.close())
      const main = await fixture.electronApp.browserWindow(page)
      await main.evaluate((win) => {
        win.show()
        win.focus()
      })
    }
  } finally {
    await fixture.cleanup()
  }
})
