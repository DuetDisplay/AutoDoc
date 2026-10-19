import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { CalendarEvent } from '../src/shared/types'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  launchIsolatedE2EApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'

interface LoggedEvent {
  message: string
  context: Record<string, any> | null
}

/** Reads the e2e app's autodocLog.log; lines are JSON. */
function readAutodocLog(userDataDir: string): { raw: string; events: LoggedEvent[] } {
  let raw = ''
  try {
    raw = readFileSync(path.join(userDataDir, 'logs', 'autodocLog.log'), 'utf8')
  } catch {
    // The log is written asynchronously; callers poll until the lines they need appear.
  }
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent)
  return { raw, events }
}

function findLogged(
  userDataDir: string,
  message: string,
  match: (context: Record<string, any>) => boolean = () => true
): Record<string, any> | undefined {
  return (
    readAutodocLog(userDataDir).events.find(
      (event) => event.message === message && match(event.context ?? {})
    )?.context ?? undefined
  )
}

for (const [windowState, action] of [
  ['hidden', 'open'],
  ['minimized', 'open'],
  ['hidden', 'dismiss']
] as const) {
  test(`an ambiguous auto-record meeting offers a visible action while AutoDoc is ${windowState} (${action})`, async () => {
    // Slack requests keep looking for a meeting window for 30 s before asking the user to pick.
    test.setTimeout(90_000)
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
        .poll(
          async () =>
            session.electronApp.evaluate(
              ({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().filter((window) => !window.isFocusable()).length
            ),
          { timeout: 45_000 }
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
        await expect
          .poll(() =>
            findLogged(
              session.userDataDir,
              'Notification banner dismissed by user',
              (c) => c.bannerKind === 'select_window'
            )
          )
          .toBeDefined()
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
      // QA triage evidence: the log explains the banner, the picker and the user's choice.
      const dir = session.userDataDir
      await expect
        .poll(() => findLogged(dir, 'renderer_diagnostic:recording_picker_result')?.details?.result)
        .toBe('picked')
      expect(
        findLogged(dir, 'Notification banner shown', (c) => c.bannerKind === 'select_window')
      ).toMatchObject({ eventId: 'timed-meeting', providerId: 'slack' })
      expect(
        findLogged(
          dir,
          'Notification banner primary action clicked',
          (c) => c.bannerKind === 'select_window'
        )
      ).toBeDefined()
      expect(findLogged(dir, 'renderer_diagnostic:recording_picker_opened')?.details).toMatchObject(
        {
          trigger: 'select_window',
          eventId: 'timed-meeting',
          sourceCount: 2,
          suggestionHighlighted: false
        }
      )
      expect(findLogged(dir, 'renderer_diagnostic:recording_picker_result')?.details).toMatchObject(
        {
          pickedIndex: expect.any(Number),
          pickedWasSuggested: false,
          sourceType: 'window'
        }
      )
      expect(
        findLogged(
          dir,
          'Meeting detection decision',
          (c) => c.reason === 'auto_record_enabled_for_event'
        )
      ).toMatchObject({ eventId: 'timed-meeting', decision: 'auto_record' })
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
    // No "Select window" notification; the only notification is the started notice.
    await expect.poll(() => session.electronApp.windows().length).toBe(2)
    const notice = session.electronApp.windows().find((window) => window !== page)!
    await expect(notice.getByText('Testing Autodoc', { exact: true })).toBeVisible()
    await expect(
      notice.getByText('AI notes started. This meeting is being recorded.', { exact: true })
    ).toBeVisible()
    await expect(notice.getByRole('button', { name: 'Select window' })).toHaveCount(0)

    // One exported autodocLog.log must explain the whole start decision for QA.
    const dir = session.userDataDir
    await expect
      .poll(() => findLogged(dir, 'Recording calendar attachment'))
      .toMatchObject({
        phase: 'recording_started',
        selectionEventId: 'timed-meeting',
        matchedEventId: 'timed-meeting',
        matchedIsAllDay: false,
        matchesSelection: true
      })
    expect(findLogged(dir, 'Meeting provider signal appeared')).toMatchObject({
      providerId: 'slack',
      activeProcessNames: ['com.tinyspeck.slackmacgap']
    })
    const candidates = findLogged(dir, 'Calendar candidates changed')
    expect(candidates).toMatchObject({
      chosenEventId: 'timed-meeting',
      chosenRule: 'only_timed_candidate'
    })
    expect(candidates?.candidates).toEqual([
      expect.objectContaining({ eventId: 'all-day', isAllDay: true, autoRecordEnabled: false }),
      expect.objectContaining({
        eventId: 'timed-meeting',
        isAllDay: false,
        autoRecordEnabled: true,
        hasMeetingUrl: false
      })
    ])
    const decision = findLogged(dir, 'renderer_diagnostic:auto_record_decision')?.details
    expect(decision).toMatchObject({
      outcome: 'auto_start',
      eventId: 'timed-meeting',
      chosenIndex: 0
    })
    expect(decision.candidates).toHaveLength(2)
    expect(decision.candidates[0]).toMatchObject({
      sourceType: 'window',
      slackHuddleName: false,
      slackMainWindowName: false,
      providerHintMatch: true
    })
    expect(decision.candidates[1]).toMatchObject({ slackMainWindowName: true })
    expect(decision.candidates[0].score).toBeGreaterThan(decision.candidates[1].score)
    expect(findLogged(dir, 'renderer_diagnostic:auto_record_start_outcome')?.details).toMatchObject(
      { outcome: 'started', eventId: 'timed-meeting' }
    )
    expect(
      findLogged(dir, 'Notification banner shown', (c) => c.bannerKind === 'recording_started')
    ).toMatchObject({ eventId: 'timed-meeting' })
    // No window title, event title, attendee or URL may reach the log.
    const { raw } = readAutodocLog(dir)
    expect(raw).not.toContain('Testing Autodoc')
    expect(raw).not.toContain('Jamal')

    // A silent automatic start must not teach AutoDoc to prefer that window next time.
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem('autodoc:recording-source-preferences') ?? '{}')
      )
    ).toEqual({})

    await notice.getByRole('button', { name: 'Stop' }).click()
    await expect
      .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
      .toMatchObject({ isRecording: false })
    // The same still-active call must not start another recording.
    await pollDetection(page, 20_000)
    expect(
      await page.evaluate(() => window.electronAPI.invoke('recording:get-state'))
    ).toMatchObject({
      isRecording: false
    })
  } finally {
    await session.cleanup()
  }
})

test('a slow capture start still shows the auto-record started notice after several recording polls', async () => {
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
      events: [timed]
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
      // Hold the capture back so the renderer's start outlasts several detection polls.
      const w = window as unknown as { __captureRequests: number; __releaseCapture: () => void }
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      w.__captureRequests = 0
      const gate = new Promise<void>((resolve) => {
        w.__releaseCapture = resolve
      })
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        w.__captureRequests++
        await gate
        return original(constraints)
      }
    })
    await setDetectionState(page, { providerActiveIds: ['com.tinyspeck.slackmacgap'] })
    await pollDetection(page)
    await expect
      .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
      .toMatchObject({ isRecording: true })
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __captureRequests: number }).__captureRequests)
      )
      .toBeGreaterThan(0)
    await pollDetection(page)
    await pollDetection(page)
    await page.evaluate(() =>
      (window as unknown as { __releaseCapture: () => void }).__releaseCapture()
    )

    await expect
      .poll(() => page.evaluate(() => window.electronAPI.invoke('recording:get-state')))
      .toMatchObject({ isRecording: true, sourceId: 'window:1:0' })
    await expect.poll(() => session.electronApp.windows().length, { timeout: 7000 }).toBe(2)
    const notice = session.electronApp.windows().find((window) => window !== page)!
    await expect(notice.getByRole('button', { name: 'Stop' })).toBeVisible()
  } finally {
    await session.cleanup()
  }
})
