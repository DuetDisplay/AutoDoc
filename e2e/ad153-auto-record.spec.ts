import { expect, test } from '@playwright/test'
import type { CalendarEvent } from '../src/shared/types'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  launchIsolatedE2EApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'

for (const [windowState, action] of [
  ['hidden', 'open'],
  ['minimized', 'open'],
  ['hidden', 'dismiss']
] as const) {
  test(`an ambiguous auto-record meeting offers a visible action while AutoDoc is ${windowState} (${action})`, async () => {
    const now = Date.now()
    const event: CalendarEvent = {
      id: 'timed-meeting',
      externalId: 'timed-meeting',
      accountId: 'calendar',
      provider: 'google',
      recurringEventId: null,
      title: 'Testing Autodoc',
      startTime: now - 60_000,
      endTime: now + 30 * 60_000,
      attendees: [],
      meetingUrl: null,
      autoRecord: 'off',
      syncedAt: now
    }
    const session = await launchIsolatedE2EApp({
      platform: 'darwin',
      permissions: { microphone: true, screen: true },
      calendar: {
        accounts: [
          { id: 'calendar', provider: 'google', email: 'qa@example.com', connectedAt: now }
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
      },
      recording: {
        sources: [
          { id: 'window:1:0', name: 'Jamal - Duet Display - Slack', thumbnailDataUrl: '' },
          { id: 'window:2:0', name: 'Jamal - Other Workspace - Slack', thumbnailDataUrl: '' }
        ]
      }
    })
    try {
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
        const qa = window as typeof window & { __ad153Requests?: unknown[] }
        qa.__ad153Requests = []
        window.electronAPI.on('detection:auto-record', (payload) =>
          qa.__ad153Requests!.push(payload)
        )
      })
      await session.electronApp.evaluate(({ BrowserWindow }, state) => {
        const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
        if (state === 'hidden') mainWindow?.hide()
        else mainWindow?.minimize()
      }, windowState)
      await setDetectionState(page, { providerActiveIds: ['com.tinyspeck.slackmacgap'] })
      await pollDetection(page)
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { __ad153Requests?: unknown[] }).__ad153Requests?.length ??
              0
          )
        )
        .toBe(1)
      await test.info().attach('auto-record-state', {
        contentType: 'application/json',
        body: JSON.stringify({
          requests: await page.evaluate(
            () => (window as typeof window & { __ad153Requests?: unknown[] }).__ad153Requests
          ),
          pickerCount: await page.getByText('Select the meeting window', { exact: true }).count(),
          windows: await session.electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              visible: window.isVisible(),
              focusable: window.isFocusable()
            }))
          )
        })
      })
      await expect
        .poll(async () =>
          session.electronApp.evaluate(
            ({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().filter((window) => !window.isFocusable()).length
          )
        )
        .toBe(1)
      await expect.poll(() => session.electronApp.windows().length).toBe(2)
      const banner = session.electronApp.windows().find((window) => window !== page)!
      await expect(banner.getByText('Testing Autodoc', { exact: true })).toBeVisible()
      await expect(banner.getByRole('button', { name: 'Select window' })).toBeVisible()
      await pollDetection(page, 20_000)
      await expect(banner.getByRole('button', { name: 'Select window' })).toBeVisible()
      await banner.screenshot({ path: test.info().outputPath('selection-banner.png') })
      expect(
        await session.electronApp.evaluate(({ BrowserWindow }, state) => {
          const mainWindow = BrowserWindow.getAllWindows().find((window) => window.isFocusable())
          return state === 'hidden' ? !mainWindow?.isVisible() : mainWindow?.isMinimized()
        }, windowState)
      ).toBe(true)
      if (action === 'dismiss') {
        const closed = banner.waitForEvent('close')
        await banner.locator('#dismiss').click()
        await closed
        await pollDetection(page, 20_000)
        expect(await page.getByText('Select the meeting window', { exact: true }).count()).toBe(0)
        expect(
          await session.electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some((window) => window.isVisible())
          )
        ).toBe(false)
        return
      }
      await banner.getByRole('button', { name: 'Select window' }).click()
      await expect(page.getByText('Select the meeting window', { exact: true })).toBeVisible()
      expect(
        await session.electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.isFocusable())
            ?.isVisible()
        )
      ).toBe(true)
      await page.getByRole('button', { name: 'Jamal - Duet Display - Slack', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
        .toMatchObject({
          isRecording: true,
          sourceId: 'window:1:0',
          trackedMeetingProviderId: 'slack'
        })
      await expect
        .poll(() =>
          page.evaluate(() =>
            JSON.parse(localStorage.getItem('autodoc:recording-source-preferences') ?? '{}')
          )
        )
        .toMatchObject({ 'event:timed-meeting': { sourceId: 'window:1:0' } })
    } finally {
      await session.cleanup()
    }
  })
}

test('a Slack huddle auto-records on the huddle window and attaches to the timed meeting', async () => {
  const now = Date.now()
  const timed: CalendarEvent = {
    id: 'timed-meeting',
    externalId: 'timed-meeting',
    accountId: 'calendar',
    provider: 'google',
    recurringEventId: null,
    title: 'Testing Autodoc',
    startTime: now - 60_000,
    endTime: now + 30 * 60_000,
    attendees: [],
    meetingUrl: null,
    autoRecord: 'off',
    syncedAt: now
  }
  const session = await launchIsolatedE2EApp({
    platform: 'darwin',
    permissions: { microphone: true, screen: true },
    calendar: {
      accounts: [{ id: 'calendar', provider: 'google', email: 'qa@example.com', connectedAt: now }],
      events: [
        {
          ...timed,
          id: 'all-day',
          title: 'Home',
          isAllDay: true,
          startTime: now - 12 * 60 * 60_000,
          endTime: now + 12 * 60 * 60_000
        },
        timed
      ]
    },
    recording: {
      sources: [
        { id: 'window:1:0', name: 'Jamal - Duet Display - Slack', thumbnailDataUrl: '' },
        { id: 'window:2:0', name: 'Jamal (DM) - Duet Display - Slack', thumbnailDataUrl: '' }
      ]
    }
  })
  try {
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
    await setDetectionState(page, { providerActiveIds: ['com.tinyspeck.slackmacgap'] })
    await pollDetection(page)

    await expect
      .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
      .toMatchObject({
        isRecording: true,
        sourceId: 'window:1:0',
        trackedMeetingProviderId: 'slack'
      })
    expect(await page.getByText('Select the meeting window', { exact: true }).count()).toBe(0)
    // No "Select window" notification: only the main window exists.
    expect(session.electronApp.windows().length).toBe(1)
    expect(
      await session.electronApp.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((window) => !window.isFocusable()).length
      )
    ).toBe(0)

    // The e2e calendar fixture bypasses the main-process calendar manager, so the recording
    // title cannot be resolved here; the remembered source is keyed by the timed event id.
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem('autodoc:recording-source-preferences') ?? '{}')
        )
      )
      .toMatchObject({ 'event:timed-meeting': { sourceId: 'window:1:0' } })
  } finally {
    await session.cleanup()
  }
})
