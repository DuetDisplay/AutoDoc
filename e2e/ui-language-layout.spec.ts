import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { completeOnboarding, launchIsolatedE2EApp } from './helpers/electron-app'
import { translate } from '../src/shared/i18n'
import {
  htmlLangForUiLanguage,
  UI_LANGUAGE_CODES,
  type UiLanguageCode
} from '../src/shared/ui-language'
import type { CalendarAccount, CalendarEvent } from '../src/shared/types'

const VIEWPORTS = [
  { width: 900, height: 700 },
  { width: 800, height: 600 }
] as const

async function resizeWindow(
  electronApp: ElectronApplication,
  page: Page,
  width: number,
  height: number
): Promise<void> {
  const browserWindow = await electronApp.browserWindow(page)
  await browserWindow.evaluate(
    (win, size) => {
      win.setContentSize(size.width, size.height)
    },
    { width, height }
  )
  await page.setViewportSize({ width, height })
}

async function setUiLanguage(page: Page, language: UiLanguageCode): Promise<void> {
  await page.evaluate(async (next) => {
    await window.electronAPI.invoke('prefs:set-ui-language', next)
  }, language)
  await expect(page.locator('html')).toHaveAttribute('lang', htmlLangForUiLanguage(language))
}

async function measureOverflow(page: Page): Promise<{
  scrollOverflow: boolean
  clipped: Array<{ text: string; right: number }>
}> {
  return page.evaluate(() => {
    const limit = window.innerWidth + 2
    const clipped = [...document.querySelectorAll('button, a, h1, [role="button"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 1 && rect.height > 1 && (rect.right > limit || rect.left < -2)
      })
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          right: Math.round(rect.right)
        }
      })

    return {
      scrollOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 1 ||
        document.body.scrollWidth > window.innerWidth + 1,
      clipped
    }
  })
}

async function expectFitsWindow(page: Page, label: string): Promise<void> {
  const overflow = await measureOverflow(page)
  expect(overflow, label).toEqual({ scrollOverflow: false, clipped: [] })
}

test('every supported UI language stays inside narrow Upcoming and Settings windows', async () => {
  test.setTimeout(180_000)
  const now = Date.now()
  const account: CalendarAccount = {
    id: 'e2e-cal',
    provider: 'google',
    email: 'e2e@example.com',
    connectedAt: now
  }
  const events: CalendarEvent[] = [
    {
      id: 'e2e-today',
      externalId: 'today',
      accountId: account.id,
      provider: 'google',
      recurringEventId: 'series',
      title: 'Roadmap Sync',
      startTime: now + 60 * 60_000,
      endTime: now + 90 * 60_000,
      attendees: ['a@example.com', 'b@example.com'],
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      autoRecord: 'off',
      syncedAt: now
    }
  ]

  const disconnected = await launchIsolatedE2EApp({
    permissions: { microphone: true, screen: true }
  })
  const connected = await launchIsolatedE2EApp({
    calendar: { accounts: [account], events },
    permissions: { microphone: true, screen: true }
  })

  try {
    const emptyPage = await disconnected.electronApp.firstWindow()
    const meetingPage = await connected.electronApp.firstWindow()
    await completeOnboarding(emptyPage)
    await completeOnboarding(meetingPage)
    await setUiLanguage(emptyPage, 'de')
    await expect(emptyPage.getByText(translate('de', 'upcoming.connectToast'))).toBeVisible()
    await expect(
      emptyPage.getByRole('button', { name: translate('de', 'upcoming.openSettings') })
    ).toBeVisible()

    for (const viewport of VIEWPORTS) {
      await resizeWindow(disconnected.electronApp, emptyPage, viewport.width, viewport.height)
      await resizeWindow(connected.electronApp, meetingPage, viewport.width, viewport.height)

      for (const language of UI_LANGUAGE_CODES) {
        await setUiLanguage(emptyPage, language)
        await setUiLanguage(meetingPage, language)

        await emptyPage.evaluate(() => {
          window.location.hash = '#/'
        })
        await expect(
          emptyPage.getByRole('heading', { name: translate(language, 'upcoming.title') })
        ).toBeVisible()
        await expect(
          emptyPage.getByRole('button', { name: translate(language, 'upcoming.connectGoogle') })
        ).toBeVisible()
        await expectFitsWindow(
          emptyPage,
          `${language} upcoming connect ${viewport.width}x${viewport.height}`
        )

        await emptyPage.evaluate(() => {
          window.location.hash = '#/settings'
        })
        await expect(
          emptyPage.getByRole('heading', { name: translate(language, 'settings.title') })
        ).toBeVisible()
        await expectFitsWindow(
          emptyPage,
          `${language} settings ${viewport.width}x${viewport.height}`
        )

        await meetingPage.evaluate(() => {
          window.location.hash = '#/'
        })
        await expect(
          meetingPage.getByRole('heading', { name: translate(language, 'upcoming.title') })
        ).toBeVisible()
        await expect(meetingPage.getByText('Roadmap Sync')).toBeVisible()
        await expect(
          meetingPage.getByRole('button', { name: translate(language, 'upcoming.enableAutoRecord') })
        ).toBeVisible()
        await expectFitsWindow(
          meetingPage,
          `${language} upcoming meetings ${viewport.width}x${viewport.height}`
        )
      }
    }
  } finally {
    await Promise.all([disconnected.cleanup(), connected.cleanup()])
  }
})
