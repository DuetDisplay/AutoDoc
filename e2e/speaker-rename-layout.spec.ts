import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { launchUiFollowupApp, openUiMeeting, setUiOutcome } from './helpers/ui-followup-fixture'
import { revealVertically, setContentSize, setUi, settleLayout } from './helpers/ui-layout'

test('speaker Rename popup fits vertically and remains usable with tall labels at every zoom', async () => {
  test.setTimeout(300000)
  const f = await launchUiFollowupApp()
  const { page, electronApp } = f
  const measurements: unknown[] = []
  try {
    for (const zoom of [2, 1.5, 1.25, 1])
      for (const theme of ['light', 'dark'] as const)
        for (const language of [
          'el' as const,
          ...UI_LANGUAGE_CODES.filter((code) => code !== 'el')
        ]) {
          await setContentSize(electronApp, page, 788, 540, zoom)
          await setUi(page, language, theme)
          await setUiOutcome(electronApp, { speakerName: '회의記録会议'.repeat(40) })
          await openUiMeeting(page)
          await page
            .getByRole('button', { name: translate(language, 'meeting.transcript'), exact: true })
            .click()
          const trigger = page.getByRole('button', {
            name: translate(language, 'ui.rename'),
            exact: true
          })
          await revealVertically(trigger)
          await trigger.focus()
          await page.keyboard.press('Enter')
          const input = page.getByRole('textbox', {
            name: translate(language, 'ui.typeACustomName'),
            exact: true
          })
          await expect(input).toBeFocused()
          await settleLayout(page)
          const popup = input.locator('../..')
          const bounds = await popup.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return {
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight
            }
          })
          measurements.push({ language, theme, zoom, ...bounds })
          if (zoom === 2 && ['el', 'uk', 'ja', 'en'].includes(language))
            await page.screenshot({
              path: test.info().outputPath(`${language}-${theme}-${zoom}.png`)
            })
          expect(bounds.y).toBeGreaterThanOrEqual(59)
          expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 15)
          expect(bounds.x).toBeGreaterThanOrEqual(15)
          expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 15)
          // Verify useful controls, not just a painted edge. Focus must scroll the
          // popup's own contents without moving the popup outside the viewport.
          await expect(input).toBeInViewport({ ratio: 0.99 })
          await page.getByRole('button', { name: 'Alex', exact: true }).focus()
          await expect(page.getByRole('button', { name: 'Alex', exact: true })).toBeInViewport({
            ratio: 0.99
          })
          await page.keyboard.press('Escape')
          await expect(input).toHaveCount(0)
          await expect(trigger).toBeFocused()
          await page.keyboard.press('Enter')
          await expect(input).toBeFocused()
          await input.fill('確認済み Morgan')
          await page.keyboard.press('Enter')
          await expect(input).toHaveCount(0)
          await expect(trigger).toBeFocused()
          await expect(page.getByText('確認済み Morgan', { exact: true }).first()).toBeVisible()
        }
  } finally {
    writeFileSync(
      test.info().outputPath('measurements.json'),
      JSON.stringify(measurements, null, 2)
    )
    await f.cleanup()
  }
})
