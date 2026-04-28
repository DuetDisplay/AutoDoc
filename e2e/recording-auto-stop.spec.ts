import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  launchIsolatedE2EApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'

const HUDDLE_WINDOW_NAME = 'Huddle: #all-autodoctest2 - AutodocTest2 - Slack'
const GENERIC_SLACK_WINDOW_NAME = 'Slack'
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p8i4AAAAASUVORK5CYII='

async function installAutoStopProbe(page: Parameters<typeof test>[0]['page']): Promise<void> {
  await page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaAutoStopEvents?: Array<Record<string, unknown>>
      __qaAutoStopProbeCleanup?: () => void
    }
    qaWindow.__qaAutoStopEvents = []
    qaWindow.__qaAutoStopProbeCleanup?.()
    qaWindow.__qaAutoStopProbeCleanup = window.electronAPI.on('detection:auto-stop', (payload) => {
      qaWindow.__qaAutoStopEvents?.push(payload as Record<string, unknown>)
    })
  })
}

async function getAutoStopEvents(page: Parameters<typeof test>[0]['page']) {
  return await page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaAutoStopEvents?: Array<Record<string, unknown>>
    }
    return qaWindow.__qaAutoStopEvents ?? []
  })
}

test('AD-71 keeps recording while a tracked Slack huddle still looks active, but stops once it degrades to generic Slack', async ({}) => {
  const now = Date.now()
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: {
      microphone: true,
      screen: true
    },
    calendar: {
      accounts: [
        {
          id: 'acct-1',
          provider: 'google',
          email: 'e2e-google@example.com',
          connectedAt: now
        }
      ],
      events: [
        {
          id: 'google_evt-ad-71',
          externalId: 'evt-ad-71',
          accountId: 'acct-1',
          provider: 'google',
          recurringEventId: null,
          title: 'AD-71 Slack Huddle',
          startTime: now - 5 * 60_000,
          endTime: now + 25 * 60_000,
          attendees: [],
          meetingUrl: 'https://app.slack.com/huddle/T123/C456',
          autoRecord: 'off',
          syncedAt: now
        }
      ]
    },
    recording: {
      sources: [
        {
          id: 'window:1',
          name: HUDDLE_WINDOW_NAME,
          thumbnailDataUrl: ONE_PIXEL_PNG
        }
      ]
    },
    detection: {
      providerActiveIds: [],
      micActive: null,
      windowSources: [{ id: 'window:1', name: HUDDLE_WINDOW_NAME }]
    }
  })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFakeCaptureDevices(page)
    await installAutoStopProbe(page)

    const recordButton = page.getByRole('button', { name: /^Record$/ })
    const stopButton = page.getByRole('button', { name: /^Stop Recording$/ })

    await expect(page.getByText('AD-71 Slack Huddle')).toBeVisible()
    await expect(recordButton).toBeVisible()
    await recordButton.click()
    await page.locator('button').filter({ hasText: HUDDLE_WINDOW_NAME }).first().click()

    await expect(stopButton).toBeVisible()
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const state = await window.electronAPI.invoke('recording:get-state')
          return state.trackedMeetingProviderId ?? null
        })
      })
      .toBe('slack')

    await setDetectionState(page, {
      providerActiveIds: [],
      micActive: false,
      windowSources: [{ id: 'window:1', name: HUDDLE_WINDOW_NAME }]
    })

    for (let i = 0; i < 12; i += 1) {
      await pollDetection(page, 3_000)
    }

    await expect(stopButton).toBeVisible()
    await expect.poll(async () => (await getAutoStopEvents(page)).length).toBe(0)

    await setDetectionState(page, {
      providerActiveIds: [],
      micActive: false,
      windowSources: [{ id: 'window:1', name: GENERIC_SLACK_WINDOW_NAME }]
    })

    for (let i = 0; i < 5; i += 1) {
      await pollDetection(page, 3_000)
    }

    await expect.poll(async () => (await getAutoStopEvents(page)).length).toBe(1)

    const autoStopEvents = await getAutoStopEvents(page)
    expect(autoStopEvents[0]).toMatchObject({
      sourceType: 'window',
      providerDetected: false,
      meetingWindowVisible: false
    })
    expect(['mic_idle', 'provider_gone']).toContain(autoStopEvents[0]?.reason)
  } finally {
    await app.cleanup()
  }
})
