import { expect, test } from '@playwright/test'
import type { E2EScenario } from '../src/shared/e2e'
import {
  completeOnboarding,
  launchIsolatedE2EApp,
  launchPackagedRealSetupApp
} from './helpers/electron-app'

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p8i4AAAAASUVORK5CYII='

async function launchPickerApp(
  scenario: E2EScenario
): Promise<Awaited<ReturnType<typeof launchIsolatedE2EApp>>> {
  const packagedAppPath = process.env.AUTODOC_E2E_PACKAGED_APP
  if (packagedAppPath) {
    return await launchPackagedRealSetupApp(packagedAppPath, {
      AUTODOC_E2E: '1',
      AUTODOC_TEST_REAL_SETUP: '0',
      AUTODOC_E2E_SCENARIO: JSON.stringify(scenario)
    })
  }
  return await launchIsolatedE2EApp(scenario)
}

test('Windows picker prefers the Slack Huddle and uses deliberate image fallbacks', async () => {
  const now = Date.now()
  const app = await launchPickerApp({
    platform: 'win32',
    calendar: {
      events: [
        {
          id: 'slack-huddle-event',
          externalId: 'slack-huddle-event',
          accountId: 'account-1',
          provider: 'google',
          recurringEventId: null,
          title: 'Product Huddle',
          startTime: now - 60_000,
          endTime: now + 30 * 60_000,
          attendees: [],
          meetingUrl: 'https://app.slack.com/huddle/product',
          autoRecord: 'off',
          syncedAt: now
        }
      ]
    },
    recording: {
      sources: [
        { id: 'window:slack-overlay', name: 'Slack', thumbnailDataUrl: '' },
        {
          id: 'window:slack-huddle',
          name: 'Huddle: #product - AutoDoc - Slack',
          thumbnailDataUrl: ''
        },
        { id: 'screen:0:0', name: 'Entire screen', thumbnailDataUrl: '' }
      ]
    }
  })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await page.evaluate(() => {
      window.localStorage.setItem(
        'autodoc:recording-source-preferences',
        JSON.stringify({
          'provider:slack': {
            sourceId: 'window:stale-overlay',
            sourceName: 'Slack',
            updatedAt: Date.now()
          }
        })
      )
    })

    await page.getByRole('button', { name: /^Record$/ }).click()

    const sourceOptions = page.getByRole('button').filter({
      has: page.locator('[data-testid$="-source-placeholder"]')
    })
    await expect(
      page.getByText('AutoDoc highlighted the most likely meeting window.')
    ).toBeVisible()
    await expect(sourceOptions).toHaveCount(3)
    await expect(sourceOptions.nth(0)).toContainText('Huddle: #product - AutoDoc - Slack')
    await expect(sourceOptions.nth(0)).toContainText('Detected meeting')
    await expect(sourceOptions.nth(1)).toContainText('Slack')
    await expect(sourceOptions.nth(2)).toContainText('Entire screen')
    await expect(page.getByTestId('window-source-placeholder')).toHaveCount(2)
    await expect(page.getByTestId('screen-source-placeholder')).toHaveCount(1)

    await sourceOptions.nth(0).focus()
    await expect(sourceOptions.nth(0)).toBeFocused()
  } finally {
    await app.cleanup()
  }
})

test('macOS picker retains available source thumbnails', async () => {
  const app = await launchPickerApp({
    platform: 'darwin',
    recording: {
      sources: [
        {
          id: 'window:zoom',
          name: 'Zoom Meeting',
          thumbnailDataUrl: ONE_PIXEL_PNG
        },
        {
          id: 'screen:0:0',
          name: 'Entire screen',
          thumbnailDataUrl: ONE_PIXEL_PNG
        }
      ]
    }
  })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await page.getByRole('button', { name: /^Record$/ }).click()

    await expect(page.getByTestId('recording-source-preview')).toHaveCount(2)
    await expect(page.getByTestId('window-source-placeholder')).toHaveCount(0)
    await expect(page.getByTestId('screen-source-placeholder')).toHaveCount(0)
  } finally {
    await app.cleanup()
  }
})
