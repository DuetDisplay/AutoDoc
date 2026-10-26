import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { launchGithubStarApp, leaveAndReturnToApp } from './helpers/github-star'

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
