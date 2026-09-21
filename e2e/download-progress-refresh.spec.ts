import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { relaunchIsolatedE2EApp } from './helpers/electron-app'

// Runs the real Electron UI and recording:list handler. The progress producer
// is controlled; real downloader coverage lives in whisper-download-progress.test.ts.
for (const platform of ['win32', 'darwin'] as const) {
  test(`download progress does not rescan recordings: ${platform} UI`, async ({}, info) => {
    test.setTimeout(90_000)
    const root = mkdtempSync(path.join(os.tmpdir(), 'autodoc-progress-'))
    writeFileSync(
      path.join(root, 'autodoc-prefs.json'),
      JSON.stringify({
        onboardingComplete: true,
        launchAtLogin: false,
        analyticsConsent: false,
        diagnosticLogUploadConsent: false
      })
    )
    const dir = path.join(root, 'recordings', 'progress-meeting')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify({
        customTitle: 'Progress verification',
        sourceName: 'Test',
        startedAt: Date.now() - 60000,
        stoppedAt: Date.now(),
        durationSeconds: 60
      })
    )
    writeFileSync(
      path.join(dir, 'transcript.json'),
      JSON.stringify([
        {
          id: '1',
          meetingId: 'progress-meeting',
          speaker: 'me',
          text: 'Progress verification meeting.',
          startMs: 0,
          endMs: 1000,
          confidence: 1
        }
      ])
    )
    const profile =
      platform === 'win32'
        ? { windowsProcessingProfileId: 'win-low-spec' as const }
        : { macProcessingProfileId: 'mac-low-spec' as const }
    const fixture = await relaunchIsolatedE2EApp(
      root,
      {
        platform,
        whisper: { status: { phase: 'downloading-model', percent: 12, ...profile } }
      },
      { ELECTRON_RENDERER_URL: '', AUTODOC_SKIP_INSTALL_POLICY: '1' }
    )
    try {
      const page = await fixture.electronApp.firstWindow()
      await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
      await expect(page.getByText('Progress verification', { exact: true })).toBeVisible()
      await expect(page.getByText('Optimized local processing is on')).toBeVisible()
      await fixture.electronApp.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as any)._invokeHandlers
        const original = handlers.get('recording:list')
        ;(globalThis as any).progressCounts = { started: 0, completed: 0 }
        ipcMain.removeHandler('recording:list')
        ipcMain.handle('recording:list', async (...args) => {
          const counts = (globalThis as any).progressCounts
          counts.started++
          try {
            return await original(...args)
          } finally {
            counts.completed++
          }
        })
      })
      const start = Date.now()
      await fixture.electronApp.evaluate(
        ({ BrowserWindow }, status) => {
          for (let n = 0; n < 5000; n++) {
            BrowserWindow.getAllWindows().forEach((w) =>
              w.webContents.send('whisper:setup-progress', status)
            )
          }
        },
        { phase: 'downloading-model', percent: 12, ...profile }
      )
      // A renderer round trip fences delivery; allow pending list handlers to drain.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
      await expect
        .poll(
          async () =>
            fixture.electronApp.evaluate(() => {
              const c = (globalThis as any).progressCounts
              return c.started === c.completed
            }),
          { timeout: 30_000 }
        )
        .toBe(true)
      const counts = await fixture.electronApp.evaluate(() => (globalThis as any).progressCounts)
      writeFileSync(
        info.outputPath('refresh-measurement.json'),
        JSON.stringify(
          {
            platform,
            nativePlatform: process.platform,
            events: 5000,
            ...counts,
            elapsedMs: Date.now() - start
          },
          null,
          2
        )
      )
      await info.attach('refresh-measurement', {
        body: JSON.stringify({
          platform,
          nativePlatform: process.platform,
          events: 5000,
          ...counts,
          elapsedMs: Date.now() - start
        }),
        contentType: 'application/json'
      })
      if (process.env.AUTODOC_JAMAL_BASELINE === '1')
        expect(counts.started).toBeGreaterThanOrEqual(5000)
      else expect(counts.started).toBeLessThan(10) // normal recordings-page polling can overlap
      await expect(page.getByText('Progress verification', { exact: true })).toBeVisible()
      await page.screenshot({ path: info.outputPath('progress-list.png') })
      await page.getByRole('button', { name: 'Got it', exact: true }).click()
      await expect(page.getByText('Optimized local processing is on')).toBeHidden()
      await page.reload()
      await expect(page.getByText('Optimized local processing is on')).toBeHidden()
      await page.evaluate(() =>
        window.electronAPI.invoke('prefs:set-low-spec-mac-processing-banner-dismissed', false)
      )
      await page.reload()
      await expect(page.getByText('Optimized local processing is on')).toBeVisible()
      await page.evaluate(() => window.electronAPI.invoke('recording:delete', 'progress-meeting'))
      if (process.env.AUTODOC_JAMAL_BASELINE !== '1') {
        await expect(page.getByText('Optimized local processing is on')).toBeHidden()
        await expect(page.getByText('Progress verification', { exact: true })).toBeHidden()
      }
    } finally {
      await fixture.cleanup()
    }
  })
}
