import { expect, test } from '@playwright/test'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  launchIsolatedExternalE2EApp,
  pollDetection,
  setDetectionState
} from './helpers/electron-app'
import type { CalendarEvent } from '../src/shared/types'

for (const provider of ['google', 'microsoft'] as const) {
  test(`AD-143 ${provider}: series changes survive background sync and still auto-record`, async () => {
    test.setTimeout(90_000)
    const now = Date.now()
    const account = { id: 'ad143-test', provider, email: 'ad143@example.test', connectedAt: now }
    const events: CalendarEvent[] = [0, 1, 2].map((i) => ({
      id: `${provider}_ad143_${i}`,
      externalId: `ad143_${i}`,
      accountId: account.id,
      provider,
      recurringEventId: `${provider}_ad143_series`,
      title: `AD-143 occurrence ${i + 1}`,
      startTime: now + 60 * 60_000 + i * 86400_000,
      endTime: now + 90 * 60_000 + i * 86400_000,
      attendees: [],
      meetingUrl: 'https://zoom.us/j/123456789',
      autoRecord: 'off',
      syncedAt: now
    }))
    const output = path.join(process.cwd(), `test-results/ad-143-fixed/${provider}`)
    mkdirSync(output, { recursive: true })
    const appRoot = mkdtempSync(path.join(os.tmpdir(), 'autodoc-ad143-build-'))
    cpSync(path.join(process.cwd(), 'out'), path.join(appRoot, 'out'), { recursive: true })
    symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(appRoot, 'node_modules'))
    symlinkSync(path.join(process.cwd(), 'build'), path.join(appRoot, 'build'))
    symlinkSync(path.join(process.cwd(), 'resources'), path.join(appRoot, 'resources'))
    cpSync(path.join(process.cwd(), 'package.json'), path.join(appRoot, 'package.json'))
    // Replace only account restoration and provider fetching in an isolated compiled copy.
    // Preserve the real startSync timer, startup callback, IPC, preference store, renderer and detection.
    appendFileSync(
      path.join(appRoot, 'out/main/index.js'),
      `
const ad143Fixture = JSON.parse(process.env.AUTODOC_E2E_SCENARIO).calendar;
CalendarManager.prototype.initialize = async function () { this.accounts = ad143Fixture.accounts; return this.getAccounts(); };
CalendarManager.prototype.fetchAllRecentEvents = async function () { return []; };
CalendarManager.prototype.fetchAllUpcomingEvents = async function () { return structuredClone(ad143Fixture.events); };
const ad143StartSync = CalendarManager.prototype.startSync;
CalendarManager.prototype.startSync = function(callback) {
  globalThis.__ad143Sync = () => this.fetchAllUpcomingEvents().then(callback);
  globalThis.__ad143MakeCurrent = () => { ad143Fixture.events[0].startTime = Date.now() - 60000; ad143Fixture.events[0].endTime = Date.now() + 1800000; };
  return ad143StartSync.call(this, callback);
};
`
    )
    const session = await launchIsolatedExternalE2EApp(appRoot, {
      calendar: { accounts: [account], events },
      permissions: { microphone: true, screen: true },
      recording: { sources: [{ id: 'window:ad143:0', name: 'Zoom Meeting', thumbnailDataUrl: '' }] }
    })
    const evidence: Record<string, unknown> = {}
    try {
      const page = await session.electronApp.firstWindow()
      await completeOnboarding(page)
      await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Enable auto-record' })).toHaveCount(3)
      await page.getByRole('button', { name: 'Enable auto-record' }).first().click()
      await page.getByRole('button', { name: /All in series/ }).click()
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      await expect(page.getByText('Auto-record: Off', { exact: true })).toHaveCount(0)
      const savedModes = await page.evaluate(async () =>
        (await window.electronAPI.invoke('calendar:get-events')).map((event) => event.autoRecord)
      )
      expect(savedModes).toEqual(['series', 'series', 'series'])
      evidence.afterSeriesClick = { visibleSeries: 3, visibleOff: 0, savedModes }
      await page.screenshot({ path: path.join(output, '01-series-all-updated.png') })
      await page.getByRole('button', { name: 'Sync', exact: true }).click()
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      evidence.afterManualSync = { visibleSeries: 3 }
      await page.screenshot({ path: path.join(output, '02-manual-sync-correct.png') })
      // Invoke the captured real startup sync callback without waiting five minutes.
      await session.electronApp.evaluate(async () => {
        await (globalThis as any).__ad143Sync()
      })
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      const persisted = JSON.parse(
        readFileSync(path.join(session.userDataDir, 'autodoc-auto-record.json'), 'utf8')
      )
      expect(persisted.auto_record_series).toContain(`${provider}_ad143_series`)
      evidence.afterStartupSync = { visibleSeries: 3, persisted }
      await page.screenshot({ path: path.join(output, '03-background-sync-preserved.png') })
      // Disabling from another occurrence immediately updates the entire series.
      await page.getByRole('button', { name: 'Disable auto-record' }).nth(1).click()
      await expect(page.getByText('Auto-record: Off', { exact: true })).toHaveCount(3)
      await page.getByRole('button', { name: 'Enable auto-record' }).first().click()
      await page.getByRole('button', { name: /This meeting/ }).click()
      await expect(page.getByText('Auto-record: On', { exact: true })).toHaveCount(1)
      await expect(page.getByText('Auto-record: Off', { exact: true })).toHaveCount(2)
      await session.electronApp.evaluate(async () => {
        await (globalThis as any).__ad143Sync()
      })
      await expect(page.getByText('Auto-record: On', { exact: true })).toHaveCount(1)
      await expect(page.getByText('Auto-record: Off', { exact: true })).toHaveCount(2)
      await page.getByRole('button', { name: 'Disable auto-record' }).click()
      await page.getByRole('button', { name: 'Enable auto-record' }).first().click()
      await page.getByRole('button', { name: /All in series/ }).click()
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      await page.reload()
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Auto-record', exact: true })).toHaveCount(0)
      await expect(page.getByText('Default: off', { exact: true })).toHaveCount(0)
      await page.screenshot({ path: path.join(output, 'settings.png') })
      await page.getByRole('link', { name: 'Upcoming', exact: true }).click()
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      evidence.otherChecks = [
        'series disabled from sibling',
        'once survives background sync',
        'series survives reload',
        'misleading Settings entry removed'
      ]
      await installFakeCaptureDevices(page)
      await page.evaluate(() => {
        ;(window as any).__ad143AutoRecord = []
        window.electronAPI.on('detection:auto-record', (payload) =>
          (window as any).__ad143AutoRecord.push(payload)
        )
      })
      await session.electronApp.evaluate(async () => {
        ;(globalThis as any).__ad143MakeCurrent()
        await (globalThis as any).__ad143Sync()
      })
      await setDetectionState(page, { providerActiveIds: ['us.zoom.xos'], micActive: true })
      await pollDetection(page)
      await expect
        .poll(async () => page.evaluate(() => (window as any).__ad143AutoRecord.length))
        .toBe(1)
      await expect(page.getByRole('button', { name: 'Stop Recording', exact: true })).toBeVisible({
        timeout: 15000
      })
      await expect(page.getByText('Auto-record: Series', { exact: true })).toHaveCount(3)
      evidence.detection = {
        broadcast: await page.evaluate(() => (window as any).__ad143AutoRecord),
        stopRecordingVisible: true,
        visibleSeries: 3,
        capture: 'synthetic media devices'
      }
      await page.screenshot({ path: path.join(output, '04-recording-with-correct-status.png') })
      writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
      console.log(JSON.stringify(evidence))
    } finally {
      writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
      await session.cleanup()
      rmSync(appRoot, { recursive: true, force: true })
    }
  })
}
