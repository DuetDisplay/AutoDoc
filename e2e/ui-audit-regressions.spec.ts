import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { launchGithubStarApp } from './helpers/github-star'
import { translate } from '../src/shared/i18n'
let root: string
test.beforeEach(() => {
  root = test.info().outputPath()
  mkdirSync(path.join(root, 'images'), { recursive: true })
})
test('meeting cards must be operable by keyboard', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
    const card = page.getByRole('link', { name: /^Product planning/ })
    await expect(card).toBeVisible()
    const tabStops: any[] = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      tabStops.push(
        await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          text: document.activeElement?.textContent,
          role: document.activeElement?.getAttribute('role')
        }))
      )
    }
    await page.screenshot({ path: path.join(root, 'images', 'fixed-keyboard-meeting-card.png') })
    writeFileSync(
      path.join(root, 'keyboard-reproduction.json'),
      JSON.stringify(
        {
          card: await card.evaluate((el) => ({
            tag: el.tagName,
            role: el.getAttribute('role'),
            tabIndex: (el as HTMLElement).tabIndex
          })),
          tabStops
        },
        null,
        2
      )
    )
    expect(
      await card.evaluate((el) => (el as HTMLElement).tabIndex),
      'Meeting card must be in keyboard tab order'
    ).toBeGreaterThanOrEqual(0)
    expect(
      tabStops.some((stop) => stop.tag === 'A' && stop.text?.includes('Product planning'))
    ).toBe(true)
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/recordings\/11111111-1111-4111-8111-111111111111/)
  } finally {
    await f.cleanup()
  }
})
test('search failure must report an error instead of retaining old results as current', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    await f.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('search:query')
      ipcMain.handle('search:query', (_e, q) => {
        if (q === 'audit-error') throw new Error('Synthetic search failure')
        return [
          {
            meetingId: 'synthetic',
            title: 'Result from PREVIOUS successful query',
            date: Date.now(),
            matches: [{ type: 'transcript', text: 'Previous successful synthetic search result' }]
          }
        ]
      })
    })
    const { page } = f
    await page.evaluate(() => {
      location.hash = '#/search'
    })
    await page.getByRole('textbox').fill('previous')
    await expect(page.getByText('Result from PREVIOUS successful query')).toBeVisible()
    await page.getByRole('textbox').fill('audit-error')
    await page.waitForTimeout(1000)
    await page.screenshot({ path: path.join(root, 'images', 'fixed-search-stale-results.png') })
    writeFileSync(
      path.join(root, 'search-reproduction.json'),
      JSON.stringify(
        {
          query: await page.getByRole('textbox').inputValue(),
          text: await page.locator('body').innerText()
        },
        null,
        2
      )
    )
    await expect(
      page.getByRole('alert'),
      'A failed search must expose a localized error'
    ).toBeVisible({ timeout: 1000 })
  } finally {
    await f.cleanup()
  }
})
test('About source-code label must provide the requested source-code link', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await page.getByText('Source code on GitHub', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(root, 'images', 'fixed-about-source-label.png') })
    const sourceLink = page.getByRole('link', { name: 'Source code on GitHub', exact: true })
    await expect(sourceLink).toBeVisible({ timeout: 1000 })
    await sourceLink.click()
    expect(await f.electronApp.evaluate(() => (globalThis as any).__starOpenedUrls)).toEqual([
      'https://github.com/DuetDisplay/AutoDoc'
    ])
  } finally {
    await f.cleanup()
  }
})
test('generated recording title date suffix must follow the selected UI locale', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await page.evaluate(() => window.electronAPI.invoke('prefs:set-ui-language', 'ja'))
    await page.evaluate(() => {
      location.hash = '#/recordings'
    })
    const title = page.getByText(/^Product planning/)
    await expect(title).toBeVisible()
    await page.screenshot({
      path: path.join(root, 'images', 'fixed-japanese-recording-title-english-date.png')
    })
    expect(
      await title.innerText(),
      'Generated UI date suffix must not contain English month/connector/AM-PM in Japanese'
    ).not.toMatch(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+ at /)
  } finally {
    await f.cleanup()
  }
})
test('already-open recording picker must update its application-owned copy after a language switch', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    await expect(page.getByText('Select a window to record', { exact: true })).toBeVisible()
    await page.evaluate(() => window.electronAPI.invoke('prefs:set-ui-language', 'ja'))
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(root, 'images', 'fixed-japanese-open-picker-english-title.png')
    })
    await expect(
      page.getByText(translate('ja', 'recording.selectWindowToRecord'), { exact: true })
    ).toBeVisible({ timeout: 1000 })
  } finally {
    await f.cleanup()
  }
})
test('recording source picker must close with Escape', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    const heading = page.getByText('Select a window to record', { exact: true })
    await expect(heading).toBeVisible()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(root, 'images', 'fixed-recording-picker-escape.png') })
    await expect(heading).toBeHidden({ timeout: 1000 })
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeFocused()
  } finally {
    await f.cleanup()
  }
})
for (const theme of ['light', 'dark'] as const)
  test(`${theme}: unfocused Search and Ask AI input boundaries must meet the requested 3:1 UI contrast target`, async () => {
    const f = await launchGithubStarApp({ qualified: false, theme })
    try {
      const { page } = f
      for (const [route, heading] of [
        ['/search', 'Search'],
        ['/ask-ai', 'Ask AI']
      ]) {
        await page.evaluate((route) => {
          location.hash = '#' + route
        }, route)
        const input = page.getByRole('textbox')
        await input.waitFor()
        await page.getByRole('heading', { name: heading, exact: true }).click()
        await page.waitForTimeout(400)
        const rect = await input.boundingBox()
        if (!rect) throw Error('Missing input bounds')
        const layout = await input.evaluate((el) => ({
          borderWidth: parseFloat(getComputedStyle(el).borderLeftWidth),
          viewportWidth: innerWidth
        }))
        const file = path.join(
          root,
          'images',
          `fixed-${theme}-${route.slice(1)}-input-boundary.png`
        )
        await page.screenshot({ path: file })
        const metadata = await sharp(file).metadata()
        const scale = metadata.width! / layout.viewportWidth
        const pixel = async (x: number, y: number) => [
          ...(await sharp(file)
            .extract({
              left: Math.floor(x * scale),
              top: Math.floor(y * scale),
              width: 1,
              height: 1
            })
            .removeAlpha()
            .raw()
            .toBuffer())
        ]
        const boundary = await pixel(rect.x + layout.borderWidth / 2, rect.y + rect.height / 2),
          outside = await pixel(rect.x - 2, rect.y + rect.height / 2),
          fill = await pixel(rect.x + 3, rect.y + rect.height / 2)
        const lum = (c: number[]) =>
          c
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
        const ratio = (a: number[], b: number[]) =>
          (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
        const measurements = {
          theme,
          route,
          scale,
          layout,
          boundary,
          outside,
          fill,
          boundaryContrast: ratio(boundary, outside),
          fillContrast: ratio(fill, outside),
          rect,
          dpr: await page.evaluate(() => devicePixelRatio)
        }
        writeFileSync(
          path.join(root, `input-boundary-${theme}-${route.slice(1)}.json`),
          JSON.stringify(measurements, null, 2)
        )
        expect(
          Math.max(measurements.boundaryContrast, measurements.fillContrast)
        ).toBeGreaterThanOrEqual(3)
      }
    } finally {
      await f.cleanup()
    }
  })
for (const theme of ['light', 'dark'] as const)
  test(`${theme}: Korean long no-results query must wrap inside the content pane`, async () => {
    const f = await launchGithubStarApp({ qualified: false, theme })
    try {
      const { page } = f
      const win = await f.electronApp.browserWindow(page)
      await win.evaluate((w) => w.setContentSize(800, 600))
      await page.setViewportSize({ width: 800, height: 600 })
      await page.evaluate(() => window.electronAPI.invoke('prefs:set-ui-language', 'ko'))
      await page.evaluate(() => {
        location.hash = '#/search'
      })
      const query = 'NoMatchingSyntheticQuery'.repeat(12)
      await page.getByRole('textbox').fill(query)
      await page.waitForTimeout(800)
      const message = page.getByText(translate('ko', 'search.noResults', { query }), {
        exact: true
      })
      await page.screenshot({
        path: path.join(root, 'images', `fixed-${theme}-korean-long-query.png`)
      })
      const r = await message.boundingBox()
      writeFileSync(path.join(root, `korean-overflow-${theme}.json`), JSON.stringify(r, null, 2))
      expect(r!.x).toBeGreaterThanOrEqual(200)
      expect(r!.x + r!.width).toBeLessThanOrEqual(800)
    } finally {
      await f.cleanup()
    }
  })
test('Ask AI application error copy must update when the UI language changes', async () => {
  const f = await launchGithubStarApp({ qualified: false })
  try {
    const { page } = f
    await f.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send-stream')
      ipcMain.handle('chat:send-stream', (event, requestId) => {
        event.sender.send('chat:error', { requestId, error: 'Synthetic chat failure' })
      })
    })
    await page.evaluate(() => {
      location.hash = '#/ask-ai'
    })
    await page.getByRole('textbox').fill('Synthetic audit question')
    await page.getByRole('textbox').press('Enter')
    await expect(page.getByText(translate('en', 'askAi.failed'), { exact: true })).toBeVisible()
    await page.evaluate(() => window.electronAPI.invoke('prefs:set-ui-language', 'ja'))
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(root, 'images', 'fixed-japanese-chat-error-english-copy.png')
    })
    await expect(page.getByText(translate('ja', 'askAi.failed'), { exact: true })).toBeVisible({
      timeout: 1000
    })
  } finally {
    await f.cleanup()
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: source-picker keyboard focus indicator meets 3:1 contrast`, async () => {
    const f = await launchGithubStarApp({ qualified: false, theme })
    try {
      const { page } = f
      await page.getByRole('button', { name: 'Record', exact: true }).click()
      const source = page.getByRole('dialog').getByRole('button').last()
      await source.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect(source).toBeFocused()
      await page.waitForTimeout(400)
      const indicator = await source.evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element)
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        const thickness = outline ? parseFloat(style.outlineWidth) : 2
        const offset = outline ? parseFloat(style.outlineOffset) : 0
        return {
          x: rect.left - offset - thickness / 2,
          y: rect.top + rect.height / 2,
          backgroundX: rect.left - offset - thickness - 3,
          width: innerWidth,
          focusVisible: element.matches(':focus-visible'),
          outline: style.outline,
          shadow: style.boxShadow
        }
      })
      expect(indicator.focusVisible).toBe(true)
      const file = path.join(root, 'images', `${theme}-source-picker-keyboard-focus.png`)
      await page.screenshot({ path: file })
      const metadata = await sharp(file).metadata()
      const scale = metadata.width! / indicator.width
      const pixel = async (x: number) => [
        ...(await sharp(file)
          .extract({
            left: Math.floor(x * scale),
            top: Math.floor(indicator.y * scale),
            width: 1,
            height: 1
          })
          .removeAlpha()
          .raw()
          .toBuffer())
      ]
      const ring = await pixel(indicator.x),
        background = await pixel(indicator.backgroundX)
      const luminance = (c: number[]) =>
        c
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const a = luminance(ring),
        b = luminance(background)
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      writeFileSync(
        path.join(root, `picker-focus-${theme}.json`),
        JSON.stringify(
          {
            ...indicator,
            scale,
            ring,
            background,
            contrast
          },
          null,
          2
        )
      )
      expect(contrast).toBeGreaterThanOrEqual(3)
    } finally {
      await f.cleanup()
    }
  })
}
