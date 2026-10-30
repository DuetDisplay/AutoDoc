import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeE2EAppKeepingUserData, removeE2EUserDataDir } from './electron-app'

export const STAR_MEETING_ID = '11111111-1111-4111-8111-111111111111'
export async function launchGithubStarApp(
  options: {
    uiAppearanceAnnouncement?: boolean
    meetingLanguageAnnouncement?: boolean
    theme?: 'light' | 'dark'
    qualified?: boolean
    duration?: number
    empty?: boolean
    failed?: boolean
    videoDir?: string
    savedPreferences?: Record<string, unknown>
  } = {}
) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'autodoc-e2e-star-'))
  const save = (file: string, value: unknown) =>
    writeFileSync(path.join(userDataDir, file), JSON.stringify(value))
  const meetingDir = path.join(userDataDir, 'recordings', STAR_MEETING_ID)
  mkdirSync(meetingDir, { recursive: true })
  const now = Date.now(),
    duration = options.duration ?? 600
  save('autodoc-prefs.json', {
    onboardingComplete: true,
    uiAppearanceAnnouncementInitialized: true,
    uiAppearanceAnnouncementPending: options.uiAppearanceAnnouncement ?? false,
    onboardingLanguageConfirmed: !options.meetingLanguageAnnouncement,
    uiLanguage: 'en',
    appearance: options.theme ?? 'light',
    analyticsConsent: false,
    diagnosticLogUploadConsent: false,
    notesEngineReadyDismissed: true,
    lowSpecMacProcessingBannerDismissed: true,
    ...options.savedPreferences
  })
  save('autodoc-github-star.json', {
    state: {
      activatedAt: now - 60_000,
      qualifiedMeetingId: options.qualified === false ? null : STAR_MEETING_ID,
      shownAt: null
    }
  })
  const writeMeeting = (file: string, value: unknown) =>
    writeFileSync(path.join(meetingDir, file), JSON.stringify(value))
  writeMeeting('metadata.json', {
    sourceName: 'Product planning',
    calendarTitle: 'Product planning',
    startedAt: now - duration * 1000,
    stoppedAt: now,
    durationSeconds: duration,
    videoProcessingFailed: options.failed ?? false
  })
  writeMeeting('transcript.json', [
    {
      id: 't1',
      meetingId: STAR_MEETING_ID,
      speaker: 'me',
      text: 'The team agreed to ship the updated meeting notes this week.',
      startMs: 0,
      endMs: 10000,
      confidence: 0.99
    }
  ])
  writeMeeting('segments.json', {
    decisions: [],
    actionItems: [],
    information: options.empty
      ? []
      : [
          {
            id: 's1',
            meetingId: STAR_MEETING_ID,
            category: 'information',
            topic: 'Release planning',
            title: 'Shipping this week',
            content: 'The team agreed to ship the updated meeting notes this week.',
            assignee: null,
            deadline: null,
            sourceStartMs: 0,
            sourceEndMs: 10000
          }
        ],
    discussion: [],
    statusUpdates: []
  })
  let electronApp: ElectronApplication, page: Page
  const start = async () => {
    electronApp = await electron.launch({
      args: [path.join(process.cwd(), 'out/main/index.js'), `--autodoc-e2e-profile=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTODOC_TEST_MODE: '1',
        AUTODOC_E2E: '1',
        AUTODOC_TEST_USER_DATA_DIR: userDataDir,
        AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com',
        AUTODOC_E2E_SCENARIO: JSON.stringify({ permissions: { microphone: true, screen: true } })
      },
      ...(options.videoDir
        ? { recordVideo: { dir: options.videoDir, size: { width: 1000, height: 720 } } }
        : {})
    })
    page = await electronApp.firstWindow()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await page.setViewportSize({ width: 1000, height: 720 })
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await electronApp.evaluate(async ({ app, BrowserWindow, shell }) => {
      if (process.platform === 'darwin') {
        await app.dock?.show()
        app.focus({ steal: true })
      }
      const main = BrowserWindow.getAllWindows()[0]
      main.setContentSize(1000, 720)
      main.show()
      main.focus()
      ;(globalThis as any).__starOpenedUrls = []
      shell.openExternal = async (url: string) => {
        ;(globalThis as any).__starOpenedUrls.push(url)
      }
    })
    await page.bringToFront()
    await page.getByRole('heading', { name: 'Upcoming', exact: true }).waitFor()
    await page
      .getByTitle('Dismiss', { exact: true })
      .click({ timeout: 1000 })
      .catch(() => {})
  }
  try {
    await start()
  } catch (error) {
    if (electronApp!) await closeE2EAppKeepingUserData(electronApp, userDataDir)
    removeE2EUserDataDir(userDataDir)
    throw error
  }
  return {
    get electronApp() {
      return electronApp
    },
    get page() {
      return page
    },
    userDataDir,
    async restart() {
      await closeE2EAppKeepingUserData(electronApp, userDataDir)
      await start()
    },
    async cleanup() {
      try {
        await closeE2EAppKeepingUserData(electronApp, userDataDir)
      } finally {
        removeE2EUserDataDir(userDataDir)
      }
    }
  }
}
export async function leaveAndReturnToApp(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    const other = new BrowserWindow({
      width: 260,
      height: 120,
      show: false,
      title: 'External browser stand-in',
      webPreferences: { nodeIntegration: false }
    })
    await other.loadURL('data:text/html,<title>Browser stand-in</title>')
    other.show()
    other.focus()
    await new Promise((resolve) => setTimeout(resolve, 250))
    main.show()
    main.focus()
    other.destroy()
  })
}
