import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { translate } from '../src/shared/i18n'
import { UI_LANGUAGE_CODES, type UiLanguageCode } from '../src/shared/ui-language'
import type { CalendarEvent } from '../src/shared/types'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  jumpToOnboardingStep,
  launchIsolatedE2EApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'
import { launchUiFollowupApp, openUiMeeting, setUiOutcome } from './helpers/ui-followup-fixture'
import {
  expectCardLayout,
  expectTextWithin,
  revealVertically,
  setContentSize,
  setUi,
  settleLayout
} from './helpers/ui-layout'

// Layout coverage for the copy added by the 1.3.1 fixes merge: localized into every UI language,
// checked at the minimum window content size (788x540) and a typical 1280x800 window.
const MIN = { width: 788, height: 540 }
const TYPICAL = { width: 1280, height: 800 }
const PASSES = [
  { size: MIN, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { size: TYPICAL, theme: 'light' as const, languages: UI_LANGUAGE_CODES },
  { size: MIN, theme: 'dark' as const, languages: ['de' as UiLanguageCode] }
]
const SHOT_LANGUAGES: UiLanguageCode[] = ['en', 'de', 'el', 'bg', 'ja']
const SHOT_DIR = process.env.RELEASE_ALERTS_SHOT_DIR

async function shot(
  target: Pick<Page, 'screenshot'>,
  name: string,
  language: UiLanguageCode,
  minimum: boolean
) {
  if (!minimum || !SHOT_LANGUAGES.includes(language)) return
  const dir = SHOT_DIR ?? test.info().outputPath('shots')
  mkdirSync(dir, { recursive: true })
  await target.screenshot({ path: path.join(dir, `${name}-${language}.png`) })
}

async function eachPass(
  app: ElectronApplication,
  page: Page,
  check: (language: UiLanguageCode, minimum: boolean, label: string) => Promise<void>
) {
  for (const { size, theme, languages } of PASSES)
    for (const language of languages) {
      await setContentSize(app, page, size.width, size.height, 1)
      await setUi(page, language, theme)
      await check(language, size === MIN, `${language} ${theme} ${size.width}x${size.height}`)
    }
}

test('No notes found badge and nothing-found callout fit in every UI language', async () => {
  test.setTimeout(600_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    await setUiOutcome(electronApp, { failureCode: 'llm-empty-output' })
    await openUiMeeting(page)
    const main = page.locator('main')
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const badge = page
        .locator('span')
        .filter({
          hasText: new RegExp(`^${escapeRegExp(translate(language, 'ui.noNotesFoundRetry'))}$`)
        })
        .first()
      await expect(badge).toBeVisible()
      await expectCardLayout(badge, `no-notes badge ${label}`)
      await expectTextWithin(badge, main)

      await page
        .getByRole('button', { name: translate(language, 'meeting.notes'), exact: true })
        .click()
      const body = main.getByText(translate(language, 'notesFailure.nothingFoundBody'), {
        exact: true
      })
      await expect(body).toBeVisible()
      const callout = body.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
      await revealVertically(callout)
      await expectCardLayout(callout, `nothing-found callout ${label}`)
      await expectTextWithin(callout, main)
      for (const key of ['meeting.tryAgain', 'meeting.viewTranscript'] as const)
        await expect(
          callout.getByRole('button', { name: translate(language, key), exact: true })
        ).toBeVisible()
      await shot(page, 'nothing-found-callout', language, minimum)
    })
  } finally {
    await f.cleanup()
  }
})

test('Sidebar model status and Settings Google reconnect message fit in every UI language', async () => {
  test.setTimeout(600_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const handle = (channel: string, fn: () => unknown) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, fn)
      }
      handle('ollama:get-setup-status', () => ({
        phase: 'error',
        percent: 0,
        error: 'model load failed',
        failedStep: 'model_load'
      }))
      handle('ollama:check-status', () => true)
      handle('calendar:get-accounts', () => [
        {
          id: 'google-reconnect',
          provider: 'google',
          email: 'qa.reviewer.with.a.long.address@example.com',
          connectedAt: Date.now(),
          syncIssue: 'reconnect-required'
        }
      ])
    })
    await page.reload()
    await expect(page.locator('aside')).toBeVisible()
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const text = page
        .locator('aside')
        .getByText(translate(language, 'nav.notesModelUnavailable'), { exact: true })
      await expect(text).toBeVisible()
      const row = text.locator('xpath=..')
      await expectCardLayout(row, `sidebar model status ${label}`)
      await expectTextWithin(row, page.locator('aside'))
      await shot(page.locator('aside'), 'sidebar-model-unavailable', language, minimum)
    })

    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await setUi(page, 'en', 'light')
    await page.getByRole('heading', { name: translate('en', 'settings.title') }).waitFor()
    await eachPass(electronApp, page, async (language, minimum, label) => {
      const message = page.getByText(translate(language, 'settings.syncReconnectRequiredGoogle'), {
        exact: true
      })
      await expect(message).toBeVisible()
      await revealVertically(message)
      await expectCardLayout(message, `settings google reconnect ${label}`)
      await expectTextWithin(message, page.locator('main'))
      await shot(page, 'settings-google-reconnect', language, minimum)
    })
  } finally {
    await f.cleanup()
  }
})

test('New heading in the combined language announcement fits in every UI language', async () => {
  test.setTimeout(600_000)
  const f = await launchUiFollowupApp()
  const { electronApp, page } = f
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('prefs:get-meeting-language-announcement-pending')
      ipcMain.handle('prefs:get-meeting-language-announcement-pending', () => true)
    })
    await page.reload()
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await eachPass(electronApp, page, async (language, minimum, label) => {
      await expect(dialog.getByText(translate(language, 'ui.new'), { exact: true })).toBeVisible()
      await expectCardLayout(
        dialog.getByRole('heading', { name: translate(language, 'ui.new'), exact: true }),
        `language announcement heading ${label}`
      )
      await shot(page, 'language-announcement-new', language, minimum)
    })
  } finally {
    await f.cleanup()
  }
})

test('onboarding notes step fits in every UI language', async () => {
  test.setTimeout(600_000)
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: { microphone: false, screen: false }
  })
  try {
    const page = await app.electronApp.firstWindow()
    await page.evaluate(() => window.electronAPI.invoke('prefs:set-onboarding-step', 3))
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('prefs:get-onboarding-language-confirmed')
      ipcMain.handle('prefs:get-onboarding-language-confirmed', () => true)
    })
    await jumpToOnboardingStep(page, 3)
    await eachPass(app.electronApp, page, async (language, minimum, label) => {
      const heading = page.getByRole('heading', {
        name: translate(language, 'ui.notesThatThink'),
        exact: true
      })
      await expect(heading).toBeVisible()
      await settleLayout(page)
      for (const key of [
        'onboarding.notesBody',
        'ui.summary',
        'onboarding.summaryDescription',
        'onboarding.topicsTitle',
        'onboarding.topicsDescription',
        'onboarding.keyTakeawaysTitle',
        'onboarding.keyTakeawaysDescription'
      ] as const) {
        const item = page.getByText(translate(language, key), { exact: true }).first()
        await expect(item, `${key} ${label}`).toBeVisible()
        await revealVertically(item)
        await expectTextWithin(item, page.locator('body'))
        const clipped = await item.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
        expect(clipped, `${key} ${label}`).toBe(false)
      }
      const horizontal = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1
      )
      expect(horizontal, `page h-scroll ${label}`).toBe(false)
      await shot(page, 'onboarding-notes-step', language, minimum)
    })
  } finally {
    await app.cleanup()
  }
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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
  await page.evaluate(() => document.fonts.ready)
}

/** Geometry audit of the separate notification BrowserWindow (fixed 400px wide, auto height). */
async function notificationProblems(notification: Page): Promise<string[]> {
  return notification.evaluate(() => {
    const out: string[] = []
    const tol = 1
    const toast = document.querySelector('.toast') as HTMLElement
    const box = toast.getBoundingClientRect()
    if (box.top < -tol || box.bottom > innerHeight + tol) out.push('toast outside window')
    if (box.left < -tol || box.right > innerWidth + tol) out.push('toast outside window width')
    if (document.documentElement.scrollWidth > innerWidth + tol) out.push('window h-scroll')
    if (document.documentElement.scrollHeight > innerHeight + tol) out.push('window v-scroll')
    const text = document.querySelector('.text')!.getBoundingClientRect()
    const actions = document.querySelector('.actions') as HTMLElement
    const a = actions.getBoundingClientRect()
    if (text.width < 140) out.push(`text column too narrow: ${text.width}`)
    if (a.left < text.right - tol) out.push('actions overlap text column')
    if (a.left < box.left - tol || a.right > box.right + tol || a.bottom > box.bottom + tol)
      out.push('actions outside toast')
    const walker = document.createTreeWalker(toast, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode,
        parent = node.parentElement!
      if (!node.textContent?.trim() || parent.closest('svg')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const r of range.getClientRects())
        if (r.width && (r.left < box.left - tol || r.right > box.right + tol))
          out.push(`text outside toast: ${node.textContent!.trim().slice(0, 30)}`)
    }
    for (const selector of ['.title', '.subtitle', '#primary-action']) {
      const el = document.querySelector(selector) as HTMLElement
      // User-provided meeting titles are deliberately clamped to two lines (full title in tooltip).
      if (!el.classList.contains('user-title') && el.scrollHeight > el.clientHeight + tol)
        out.push(`${selector} clipped vertically`)
      if (el.scrollWidth > el.clientWidth + tol) out.push(`${selector} clipped horizontally`)
    }
    const title = document.querySelector('.title') as HTMLElement
    if (title.classList.contains('user-title')) {
      const lines =
        title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)
      if (lines > 2.1) out.push(`user title ${lines} lines`)
    }
    // Copy words must fit unbroken; only user-provided titles may break mid-word.
    const style = document.createElement('style')
    style.textContent =
      '.subtitle, #primary-action { overflow-wrap: normal !important; word-break: normal !important; }'
    document.head.append(style)
    for (const selector of ['.subtitle', '#primary-action']) {
      const el = document.querySelector(selector) as HTMLElement
      if (el.scrollWidth > el.clientWidth + tol)
        out.push(`${selector} only fits by breaking mid-word`)
    }
    style.remove()
    return out
  })
}

const LONG_TITLE = 'Quarterly product roadmap, engineering priorities and release readiness review'

function calendarScenario(now: number) {
  const event: CalendarEvent = {
    id: 'timed-meeting',
    externalId: 'timed-meeting',
    accountId: 'calendar',
    provider: 'google',
    recurringEventId: null,
    title: LONG_TITLE,
    startTime: now - 60_000,
    endTime: now + 30 * 60_000,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: now
  }
  return {
    accounts: [
      { id: 'calendar', provider: 'google' as const, email: 'qa@example.com', connectedAt: now }
    ],
    events: [
      {
        ...event,
        id: 'all-day',
        title: 'Home',
        isAllDay: true,
        startTime: now - 12 * 60 * 60_000,
        endTime: now + 12 * 60 * 60_000
      },
      event
    ]
  }
}

async function launchAutoRecordApp(sources: { id: string; name: string }[]) {
  const now = Date.now()
  const session = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: { microphone: true, screen: true },
    calendar: calendarScenario(now),
    recording: { sources: sources.map((s) => ({ ...s, thumbnailDataUrl: '' })) }
  })
  const page = await session.electronApp.firstWindow()
  await page.evaluate(() =>
    window.electronAPI.invoke('prefs:dismiss-meeting-language-announcement')
  )
  await completeOnboarding(page)
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
  await page.evaluate(async () => {
    await window.electronAPI.invoke('calendar:sync')
    await window.electronAPI.invoke('calendar:set-auto-record', 'timed-meeting', null, 'once')
  })
  return { session, page }
}

async function eachNotificationLanguage(
  page: Page,
  notification: Page,
  expected: {
    body: 'recording.startedNoticeBody' | 'recording.chooseWindow'
    action: 'recording.stop' | 'recording.selectWindow'
  },
  name: string
) {
  for (const theme of ['light', 'dark'] as const)
    for (const language of UI_LANGUAGE_CODES) {
      await page.evaluate(
        async ({ language, theme }) => {
          await window.electronAPI.invoke('prefs:set-ui-language', language)
          await window.electronAPI.invoke('prefs:set-appearance', theme)
        },
        { language, theme }
      )
      await expect(notification.locator('.subtitle')).toHaveText(translate(language, expected.body))
      await expect(notification.locator('#primary-action')).toHaveText(
        translate(language, expected.action)
      )
      await settleNotification(notification, theme)
      await expect
        .poll(() => notificationProblems(notification), { message: `${name} ${language} ${theme}` })
        .toEqual([])
      await shot(notification, `${name}-${theme}`, language, theme === 'light')
    }
}

test('select-window banner and picker subtitle fit in every UI language', async () => {
  // Slack requests look for a meeting window for 30 s before asking the user to pick.
  test.setTimeout(420_000)
  const { session, page } = await launchAutoRecordApp([
    { id: 'window:1:0', name: 'Jamal - Duet Display - Slack' },
    { id: 'window:2:0', name: 'Jamal - Other Workspace - Slack' }
  ])
  try {
    await session.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.isFocusable())
        ?.hide()
    })
    await setDetectionState(page, { providerActiveIds: ['com.tinyspeck.slackmacgap'] })
    await pollDetection(page)
    await expect
      .poll(
        async () =>
          session.electronApp.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().filter((window) => !window.isFocusable()).length
          ),
        { timeout: 60_000 }
      )
      .toBe(1)
    const banner = session.electronApp.windows().find((window) => window !== page)!
    await expect(banner.getByRole('button', { name: 'Select window' })).toBeVisible()
    await eachNotificationLanguage(
      page,
      banner,
      { body: 'recording.chooseWindow', action: 'recording.selectWindow' },
      'select-window-banner'
    )

    // The banner opens the picker; its subtitle is the new copy.
    await setUi(page, 'en', 'light')
    await banner.getByRole('button', { name: 'Select window' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await eachPass(session.electronApp, page, async (language, minimum, label) => {
      const subtitle = dialog.getByText(
        translate(language, 'recording.chooseMeetingWindowSubtitle'),
        {
          exact: true
        }
      )
      await expect(subtitle).toBeVisible()
      await expect(
        dialog.getByText(translate(language, 'ui.selectTheMeetingWindow'), { exact: true })
      ).toBeVisible()
      await settleLayout(page)
      const problems = await dialog.evaluate((root) => {
        const out: string[] = []
        const r = root.getBoundingClientRect()
        if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight)
          out.push('picker outside viewport')
        if (root.scrollWidth > root.clientWidth + 1) out.push('picker h-overflow')
        for (const p of root.querySelectorAll(':scope > p')) {
          const pr = p.getBoundingClientRect()
          if (pr.left < r.left || pr.right > r.right)
            out.push(`header outside picker: ${p.textContent}`)
          if (p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)
            out.push(`header clipped: ${p.textContent}`)
        }
        return out
      })
      expect(problems, `picker ${label}`).toEqual([])
      await expectTextWithin(subtitle, dialog)
      await shot(page, 'picker-subtitle', language, minimum)
    })
  } finally {
    await session.cleanup()
  }
})

test('AI notes started notice fits in every UI language', async () => {
  test.setTimeout(300_000)
  const { session, page } = await launchAutoRecordApp([
    { id: 'window:1:0', name: 'Jamal - Duet Display - Slack' },
    { id: 'window:2:0', name: 'Jamal (DM) - Duet Display - Slack' }
  ])
  try {
    // Keep the 15 s notice up while every language and theme is checked.
    await session.electronApp.evaluate(() => {
      const real = globalThis.setTimeout.bind(globalThis)
      ;(globalThis as any).setTimeout = (fn: any, ms?: number, ...args: any[]) =>
        real(fn, ms === 15_000 ? 900_000 : ms, ...args)
    })
    await setDetectionState(page, { providerActiveIds: ['com.tinyspeck.slackmacgap'] })
    await pollDetection(page)
    await expect
      .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
      .toMatchObject({ isRecording: true })
    await expect.poll(() => session.electronApp.windows().length).toBe(2)
    const notice = session.electronApp.windows().find((window) => window !== page)!
    await expect(
      notice.getByText('AI notes started. This meeting is being recorded.', { exact: true })
    ).toBeVisible()
    await eachNotificationLanguage(
      page,
      notice,
      { body: 'recording.startedNoticeBody', action: 'recording.stop' },
      'started-notice'
    )
    await setUi(page, 'en', 'light')
    await notice.getByRole('button', { name: 'Stop' }).click()
  } finally {
    await session.cleanup()
  }
})
