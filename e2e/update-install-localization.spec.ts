import { test, expect } from '@playwright/test'
import { launchGithubStarApp } from './helpers/github-star'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'

const reasons = [
  ['Finish your recording before restarting.', 'settings.finishRecordingBeforeRestart'],
  ['AutoDoc is starting. Try again shortly.', 'update.startingBeforeRestart'],
  [
    'AutoDoc is processing your meeting. Restart when it finishes.',
    'update.processingBeforeRestart'
  ],
  ['Wait for the model download to finish before restarting.', 'update.downloadBeforeRestart'],
  ['AutoDoc is saving your recording.', 'update.savingBeforeRestart']
] as const

test('restart guards stay localized and fit every language in both themes', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp({ qualified: false })
  const { page, electronApp } = fixture
  try {
    const win = await electronApp.browserWindow(page)
    await win.evaluate((w) => w.setContentSize(800, 600))
    await page.setViewportSize({ width: 800, height: 600 })
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}'
    })
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('updater:get-status')
      ipcMain.handle(
        'updater:get-status',
        () => (globalThis as any).__updateGuardStatus ?? { state: 'idle' }
      )
    })
    for (const theme of ['light', 'dark'] as const) {
      for (const language of UI_LANGUAGE_CODES) {
        await page.evaluate(
          async ({ language, theme }) => {
            await window.electronAPI.invoke('prefs:set-ui-language', language)
            await window.electronAPI.invoke('prefs:set-appearance', theme)
            location.hash = '#/settings'
          },
          { language, theme }
        )
        for (const [reason, key] of reasons) {
          await electronApp.evaluate(({ BrowserWindow }, reason) => {
            const status = { state: 'downloaded', version: '1.3.2', installBlockedReason: reason }
            ;(globalThis as any).__updateGuardStatus = status
            for (const window of BrowserWindow.getAllWindows())
              window.webContents.send('updater:status', status)
          }, reason)
          const message = page.getByText(translate(language, key), { exact: true }).first()
          await expect(message).toBeVisible()
          await expect(
            page.getByRole('button', { name: translate(language, 'ui.restart'), exact: true })
          ).toBeDisabled()
          await expect(
            page.getByRole('button', {
              name: translate(language, 'settings.restartToUpdate', { version: '1.3.2' }),
              exact: true
            })
          ).toBeDisabled()
          expect(
            await message.evaluate((el) => {
              const r = el.getBoundingClientRect()
              return r.left >= 200 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1
            }),
            `${language} ${theme} ${key}`
          ).toBe(true)
          await page.screenshot({ path: test.info().outputPath(`${language}-${theme}-${key}.png`) })
        }
      }
    }
  } finally {
    await fixture.cleanup()
  }
})
