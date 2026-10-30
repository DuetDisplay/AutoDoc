import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../src/shared/ui-language'
import { launchGithubStarApp } from './helpers/github-star'
import {
  expectCardLayout,
  expectTextWithin,
  revealVertically,
  setContentSize,
  setUi,
  settleLayout
} from './helpers/ui-layout'

const SHOT_DIR =
  process.env.NEW_CARD_SHOTS ?? path.join('test-results', 'ui-appearance-announcement-shots')

const SIZES = [
  [788, 540],
  [1024, 640],
  [1280, 800],
  [1600, 600],
  [788, 1000],
  [1920, 1200]
] as const
const CORE: UiLanguageCode[] = ['en', 'de', 'fr', 'ru', 'el', 'pt', 'ja', 'zh-Hans', 'ko']
const SHOT_LANGUAGES: UiLanguageCode[] = ['en', 'de', 'ru', 'ja']

/** Geometry rules shared by every state of the card. */
async function auditCard(
  page: Page,
  dialog: Locator,
  label: string,
  meeting: boolean,
  language: UiLanguageCode
) {
  const card = await dialog.boundingBox()
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  expect(card!.x, label).toBeGreaterThanOrEqual(0)
  expect(card!.y, label).toBeGreaterThanOrEqual(0)
  expect(card!.x + card!.width, label).toBeLessThanOrEqual(viewport.w + 1)
  expect(card!.y + card!.height, label).toBeLessThanOrEqual(viewport.h + 1)

  // Header: pill and greeting stay inside the card and never wrap or clip.
  const pill = dialog.getByRole('heading', { level: 2 })
  await expect(pill).toBeVisible()
  await expectCardLayout(pill, `pill ${label}`)
  const greeting = await dialog.locator('[data-announcement-greeting] span').evaluateAll((spans) =>
    spans.map((span) => {
      const range = document.createRange()
      range.selectNodeContents(span)
      const r = range.getBoundingClientRect()
      const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size
      return { text: span.textContent, left: r.left, right: r.right, lines, h: r.height }
    })
  )
  expect(greeting.length).toBeGreaterThan(0)
  for (const g of greeting) {
    expect(g.lines, `${label} greeting wraps: ${g.text}`).toBe(1)
    expect(g.left, `${label} greeting left: ${g.text}`).toBeGreaterThanOrEqual(card!.x + 8)
    expect(g.right, `${label} greeting right: ${g.text}`).toBeLessThanOrEqual(
      card!.x + card!.width - 8
    )
  }
  const box = await dialog.locator('[data-announcement-greeting]').boundingBox()
  expect(Math.round(box!.height), `${label} greeting height reserved`).toBe(40)

  // Rows: icon, label and picker geometry, including the wrapped-picker alignment rule.
  const regions = await dialog.getByRole('region').all()
  expect(regions.length).toBe(meeting ? 3 : 2)
  for (const section of regions) {
    await revealVertically(section)
    await expectCardLayout(section, `row ${label}`)
    const geometry = await section.evaluate((root) => {
      const title = root.querySelector('h3')!
      const line = title.parentElement!
      const picker = title.nextElementSibling as HTMLElement | null
      const icon = root.firstElementChild as HTMLElement
      const column = line.parentElement!
      const t = title.getBoundingClientRect()
      const p = picker?.getBoundingClientRect()
      return {
        icon: icon.getBoundingClientRect().toJSON(),
        column: column.getBoundingClientRect().toJSON(),
        title: t.toJSON(),
        picker: p ? p.toJSON() : null,
        paragraphs: [...column.querySelectorAll(':scope > p')].map((x) =>
          x.getBoundingClientRect().toJSON()
        )
      }
    })
    expect(geometry.icon.right, `${label} icon precedes text`).toBeLessThanOrEqual(
      geometry.column.left + 1
    )
    expect(
      Math.abs(geometry.title.left - geometry.column.left),
      `${label} title at column`
    ).toBeLessThan(1.5)
    if (geometry.picker) {
      const wrapped = geometry.picker.top >= geometry.title.bottom - 1
      if (wrapped)
        expect(
          Math.abs(geometry.picker.left - geometry.title.left),
          `${label} wrapped picker aligns with label`
        ).toBeLessThan(1.5)
      else
        expect(geometry.picker.left, `${label} picker right of label`).toBeGreaterThan(
          geometry.title.right - 1
        )
      expect(geometry.picker.right, `${label} picker in column`).toBeLessThanOrEqual(
        geometry.column.right + 1
      )
    }
    for (const paragraph of geometry.paragraphs) {
      expect(paragraph.left, `${label} paragraph at column`).toBeGreaterThanOrEqual(
        geometry.column.left - 1
      )
      expect(paragraph.right, `${label} paragraph in column`).toBeLessThanOrEqual(
        geometry.column.right + 1
      )
    }
  }

  // Appearance choices: both visible, one checked, fully inside the card.
  const radios = dialog.getByRole('radio')
  await expect(radios).toHaveCount(2)
  await revealVertically(radios.first())
  await expectCardLayout(dialog.getByRole('radiogroup'), `radios ${label}`)
  await expect(dialog.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1)

  // The footer stays pinned and reachable; the scrolling middle can reach its end.
  const actions = dialog.locator('[data-announcement-actions]')
  await expectCardLayout(actions, `actions ${label}`)
  await expectTextWithin(dialog)
  const a = await actions.boundingBox()
  expect(a!.y, `${label} actions top`).toBeGreaterThanOrEqual(card!.y)
  expect(a!.y + a!.height, `${label} actions bottom`).toBeLessThanOrEqual(
    card!.y + card!.height + 1
  )
  for (const name of [translate(language, 'ui.later'), translate(language, 'announcement.done')])
    await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
  const reachable = await dialog.evaluate((root) => {
    const scroller = [...root.children].find(
      (el) => getComputedStyle(el).overflowY === 'auto'
    ) as HTMLElement
    scroller.scrollTop = scroller.scrollHeight
    const last = scroller.lastElementChild!.getBoundingClientRect()
    return last.bottom <= scroller.getBoundingClientRect().bottom + 1
  })
  expect(reachable, `${label} end of content reachable`).toBe(true)
  await dialog.evaluate((root) => {
    const scroller = [...root.children].find(
      (el) => getComputedStyle(el).overflowY === 'auto'
    ) as HTMLElement
    scroller.scrollTop = 0
  })
}

async function settleGreeting(page: Page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-greeting-visible]')
    return !!el && getComputedStyle(el).opacity === '1'
  })
}

async function shoot(page: Page, dialog: Locator, name: string, full = false) {
  mkdirSync(SHOT_DIR, { recursive: true })
  await settleGreeting(page)
  await dialog.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
  if (full) await page.screenshot({ path: path.join(SHOT_DIR, `${name}_full.png`) })
}

const STATES = [
  { name: 'nomeeting', meeting: false, meetingLanguage: 'en' },
  { name: 'meeting', meeting: true, meetingLanguage: 'en' },
  { name: 'meetingzh', meeting: true, meetingLanguage: 'zh-Hans' }
]

for (const state of STATES) {
  test(`upgrade card layout (${state.name})`, async () => {
    test.setTimeout(900_000)
    const fixture = await launchGithubStarApp({
      qualified: false,
      uiAppearanceAnnouncement: true,
      meetingLanguageAnnouncement: state.meeting,
      savedPreferences: { meetingLanguage: state.meetingLanguage }
    })
    const { page, electronApp } = fixture
    try {
      const dialog = page.locator('dialog[data-announcement="ui-appearance"]')
      await expect(dialog).toBeVisible()
      if (state.meeting)
        await expect(
          dialog.getByRole('heading', { name: 'Meeting language', exact: true })
        ).toBeVisible()
      const worst = state.name === 'meetingzh'
      for (const [width, height] of SIZES) {
        await setContentSize(electronApp, page, width, height, 1)
        const small = width === 788 && height === 540
        const languages = worst
          ? small || (width === 788 && height === 1000)
            ? small
              ? UI_LANGUAGE_CODES
              : SHOT_LANGUAGES
            : []
          : small
            ? UI_LANGUAGE_CODES
            : CORE
        for (const theme of ['light', 'dark'] as const) {
          for (const language of languages) {
            await setUi(page, language, theme)
            if (state.meeting)
              await expect(dialog.locator('section h3 + div button').first()).toBeEnabled()
            const label = `${language} ${width}x${height} ${theme} ${state.name}`
            await auditCard(page, dialog, label, state.meeting, language)
            const name = `${language}_${width}x${height}_${theme}_${state.name}`
            const core = SHOT_LANGUAGES.includes(language)
            if (
              (theme === 'light' && core) ||
              (theme === 'dark' && ['en', 'ru'].includes(language) && (small || width === 1280)) ||
              (worst && language === 'ru')
            )
              await shoot(page, dialog, name, small && ['en', 'ru'].includes(language))
          }
        }
      }
    } finally {
      await fixture.cleanup()
    }
  })
}

test('greeting rotates, restarts per language, and respects reduced motion', async () => {
  const fixture = await launchGithubStarApp({
    qualified: false,
    uiAppearanceAnnouncement: true,
    meetingLanguageAnnouncement: false
  })
  const { page } = fixture
  try {
    const dialog = page.locator('dialog[data-announcement="ui-appearance"]')
    await expect(dialog).toBeVisible()
    const visible = dialog.locator('[data-greeting-visible]')
    await expect(visible).toHaveText('Hello')
    await expect(visible).not.toHaveText('Hello', { timeout: 5000 })
    await expect(dialog.locator('[data-announcement-greeting]')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
    await dialog.getByRole('button', { name: 'App language' }).click()
    await page.getByRole('option', { name: 'Français', exact: true }).click()
    await expect(visible).toHaveText('Bonjour')
    await expect(visible).toHaveAttribute('lang', 'fr')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await settleLayout(page)
    await expect(dialog.locator('[data-announcement-greeting] span')).toHaveCount(1)
    await page.waitForTimeout(3000)
    await expect(visible).toHaveText('Bonjour')
    // Keyboard: Tab onto a preview choice and activate it with Space.
    await dialog.locator('[data-appearance-choice="dark"]').focus()
    await page.keyboard.press('Space')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(dialog.locator('[data-appearance-choice="dark"]')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(
      page.locator('aside').getByRole('switch'),
      'sidebar stays mounted behind the modal'
    ).toHaveCount(1)
  } finally {
    await fixture.cleanup()
  }
})
