import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launchGithubStarApp, leaveAndReturnToApp } from './helpers/github-star'

async function listLayout(page: Page) {
  return await page.getByText(/^Product planning/).evaluate((title) => {
    const item = title.closest('.cursor-pointer')!
    const list = item.parentElement!.parentElement!
    const header = list.parentElement!.querySelector('.border-b')!
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      listTop: list.getBoundingClientRect().top,
      firstItemTop: item.getBoundingClientRect().top,
      listPaddingTop: parseFloat(getComputedStyle(list).paddingTop),
      scrollTop: list.scrollTop
    }
  })
}

async function expectListAtTop(page: Page, label: string) {
  await expect
    .poll(async () => {
      const layout = await listLayout(page)
      return layout.listTop - layout.headerBottom
    })
    .toBe(0)
  const layout = await listLayout(page)
  expect(layout.firstItemTop - layout.headerBottom).toBe(layout.listPaddingTop)
  expect(layout.scrollTop).toBe(0)
  await test.info().attach(`${label}-layout`, {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json'
  })
  await page.screenshot({ path: test.info().outputPath(`${label}.png`) })
}

test('GitHub request opens the fixed repository, thanks on click, fades on return, and survives restart', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const fixture = await launchGithubStarApp({ theme })
    try {
      const { page, electronApp } = fixture
      await page.getByText('AI Notes', { exact: true }).click()
      const card = page.getByRole('region', { name: 'Enjoying AutoDoc?', exact: true })
      await expect(card.getByRole('button', { name: 'Star on GitHub', exact: true })).toBeEnabled()
      expect(
        JSON.parse(readFileSync(path.join(fixture.userDataDir, 'autodoc-github-star.json'), 'utf8'))
          .state.shownAt
      ).toBeGreaterThan(0)
      await page.screenshot({ path: test.info().outputPath(`${theme}-request.png`) })
      await card.getByRole('button', { name: 'Star on GitHub', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Thanks for the support!', exact: true })
      ).toBeVisible()
      for (const width of [800, 1000]) {
        await page.setViewportSize({ width, height: 720 })
        const centers = await page
          .getByRole('region', { name: 'Thanks for the support!', exact: true })
          .evaluate((region) => {
            const center = (el: Element) => {
              const r = el.getBoundingClientRect()
              return r.top + r.height / 2
            }
            return {
              card: center(region),
              icon: center(region.querySelector('span[aria-hidden="true"]')!),
              text: center(region.querySelector('h2')!),
              close: center(region.querySelector('button')!)
            }
          })
        for (const value of Object.values(centers))
          expect(Math.abs(value - centers.card)).toBeLessThanOrEqual(1)
      }
      expect(await electronApp.evaluate(() => (globalThis as any).__starOpenedUrls)).toEqual([
        'https://github.com/DuetDisplay/AutoDoc'
      ])
      await page.screenshot({ path: test.info().outputPath(`${theme}-thanks.png`) })
      await leaveAndReturnToApp(electronApp)
      await expect(
        page.getByRole('heading', { name: 'Thanks for the support!', exact: true })
      ).toHaveCount(0)
      await expectListAtTop(page, `${theme}-after-return`)
      await page.getByText('Settings', { exact: true }).click()
      const about = page.getByText('Source code on GitHub', { exact: true })
      await about.scrollIntoViewIfNeeded()
      await page.getByRole('link', { name: 'Star AutoDoc', exact: true }).click()
      expect(await electronApp.evaluate(() => (globalThis as any).__starOpenedUrls)).toHaveLength(2)
      await fixture.restart()
      await fixture.page.getByText('AI Notes', { exact: true }).click()
      await expect(fixture.page.getByText(/^Product planning/)).toBeVisible()
      await expect(
        fixture.page.getByRole('region', { name: 'Enjoying AutoDoc?', exact: true })
      ).toHaveCount(0)
    } finally {
      await fixture.cleanup()
    }
  }
})

for (const theme of ['light', 'dark'] as const) {
  for (const action of ['No thanks', 'Dismiss'] as const) {
    test(`${theme}: ${action} removes the banner space and restores the list to the top`, async () => {
      const fixture = await launchGithubStarApp({ theme })
      try {
        const { page } = fixture
        await page.getByText('AI Notes', { exact: true }).click()
        const card = page.getByRole('region', { name: 'Enjoying AutoDoc?', exact: true })
        await expect(card.getByRole('button', { name: action, exact: true })).toBeEnabled()
        const before = await listLayout(page)
        expect(before.listTop).toBeGreaterThan(before.headerBottom)
        await page.screenshot({ path: test.info().outputPath(`${theme}-before-dismiss.png`) })
        await card.getByRole('button', { name: action, exact: true }).click()
        await expect(card).toHaveCount(0)
        await expectListAtTop(page, `${theme}-after-dismiss`)
      } finally {
        await fixture.cleanup()
      }
    })
  }
}

test('one-time GitHub request skips old, short, empty and failed meetings', async () => {
  for (const options of [
    { qualified: false },
    { duration: 179 },
    { empty: true },
    { failed: true }
  ]) {
    const fixture = await launchGithubStarApp(options)
    try {
      await fixture.page.getByText('AI Notes', { exact: true }).click()
      await expect(fixture.page.getByText(/^Product planning/)).toBeVisible()
      expect(
        await fixture.page.evaluate(() => window.electronAPI.invoke('github-star:reserve'))
      ).toBeNull()
      await expect(fixture.page.getByText('Enjoying AutoDoc?', { exact: true })).toHaveCount(0)
    } finally {
      await fixture.cleanup()
    }
  }
})

test('eligible feedback wins over the GitHub card and suppresses it for that session/day', async () => {
  const fixture = await launchGithubStarApp()
  try {
    const { page } = fixture
    expect(
      await page.evaluate(() =>
        window.electronAPI.invoke('e2e:set-feedback-prompt-fixture', 'initial-eligible')
      )
    ).toBe(true)
    await page.getByText('AI Notes', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Share feedback', exact: true })).toBeEnabled()
    await expect(page.getByText('Enjoying AutoDoc?', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Maybe later', exact: true }).click()
    expect(await page.evaluate(() => window.electronAPI.invoke('github-star:reserve'))).toBeNull()
  } finally {
    await fixture.cleanup()
  }
})

test('high-zoom star requests keep every translated action reachable by scrolling', async () => {
  test.setTimeout(180_000)
  const fixture = await launchGithubStarApp()
  const { page, electronApp } = fixture
  try {
    const native = await electronApp.browserWindow(page)
    await native.evaluate((w) => w.setContentSize(800, 600))
    await page.setViewportSize({ width: 800, height: 600 })
    await page.evaluate(() => {
      location.hash = '#/recordings'
    })
    await expect(page.getByRole('button', { name: 'Star on GitHub', exact: true })).toBeEnabled()
    await native.evaluate((w) => w.webContents.setZoomFactor(2))
    for (const theme of ['light', 'dark'] as const)
      for (const language of UI_LANGUAGE_CODES) {
        await page.evaluate(
          async ({ theme, language }) => {
            await window.electronAPI.invoke('prefs:set-ui-language', language)
            await window.electronAPI.invoke('prefs:set-appearance', theme)
          },
          { theme, language }
        )
        const card = page.getByRole('region', {
          name: translate(language, 'githubStar.heading'),
          exact: true
        })
        await expect(card).toBeVisible()
        for (const key of ['githubStar.star', 'githubStar.noThanks'] as const) {
          const button = card.getByRole('button', { name: translate(language, key), exact: true })
          await button.evaluate((el) => {
            const pane = el.closest('main')!,
              target = el.getBoundingClientRect(),
              bounds = pane.getBoundingClientRect()
            pane.scrollTop += target.top - bounds.top - bounds.height / 2
          })
          await expect(button).toBeInViewport({ ratio: 1 })
          await button.click({ trial: true })
        }
        expect(
          await card.evaluate((el) => {
            for (let p = el.parentElement; p; p = p.parentElement) {
              if (getComputedStyle(p).overflowY === 'hidden' && p.scrollHeight > p.clientHeight + 1)
                return false
            }
            return true
          })
        ).toBe(true)
        await page.screenshot({
          path: test.info().outputPath(`star-zoom-${language}-${theme}.png`)
        })
      }
    const dismiss = page.getByRole('button', {
      name: translate(UI_LANGUAGE_CODES[UI_LANGUAGE_CODES.length - 1], 'githubStar.noThanks'),
      exact: true
    })
    await dismiss.click()
    await expect(
      page.getByRole('region', {
        name: translate(UI_LANGUAGE_CODES[UI_LANGUAGE_CODES.length - 1], 'githubStar.heading'),
        exact: true
      })
    ).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Product planning/ })).toBeVisible()
  } finally {
    await fixture.cleanup()
  }
})
