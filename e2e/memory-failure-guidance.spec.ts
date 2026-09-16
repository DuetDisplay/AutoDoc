import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { relaunchIsolatedE2EApp } from './helpers/electron-app'

for (const platform of ['win32', 'darwin'] as const) {
  test(`memory failure guidance: ${platform} UI`, async ({}, testInfo) => {
    const userData = mkdtempSync(path.join(os.tmpdir(), 'autodoc-memory-guidance-'))
    writeFileSync(
      path.join(userData, 'autodoc-prefs.json'),
      JSON.stringify({
        onboardingComplete: true,
        launchAtLogin: false,
        analyticsConsent: false,
        diagnosticLogUploadConsent: false
      })
    )
    const errors = {
      transcription:
        platform === 'win32'
          ? 'Insufficient free memory for GPU transcription pass (1.9 GiB free, floor 2.5 GiB) after extended wait'
          : 'mlx whisper failed: Metal out of memory',
      notes:
        'Ollama returned 500: model requires more system memory (3.4 GiB) than is available (1.2 GiB)',
      generic: 'whisper.cpp exited with code null (signal SIGABRT): ggml_metal_rsets_free'
    }
    for (const [stage, error] of Object.entries(errors)) {
      const meetingId = `memory-${stage}`
      const dir = path.join(userData, 'recordings', meetingId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, 'metadata.json'),
        JSON.stringify({
          customTitle:
            stage === 'transcription'
              ? 'Product planning'
              : stage === 'notes'
                ? 'Design review'
                : 'Other failure',
          sourceName: 'Google Meet',
          startedAt: Date.now() - 1080000,
          stoppedAt: Date.now(),
          durationSeconds: 1080
        })
      )
      if (stage === 'notes') {
        writeFileSync(
          path.join(dir, 'transcript.json'),
          JSON.stringify([
            {
              id: '1',
              meetingId,
              speaker: 'me',
              text: 'We agreed to finish the updated design by Thursday.',
              startMs: 0,
              endMs: 10000,
              confidence: 1
            }
          ])
        )
      } else {
        // A failed transcription has saved audio but no completed transcript.
        // This UI fixture is never played or sent to a transcription engine.
        writeFileSync(path.join(dir, 'mic.webm'), 'ui-test-audio')
      }
      writeFileSync(
        path.join(dir, stage === 'notes' ? 'segments.error' : 'transcript.error'),
        JSON.stringify({ error, retries: 3 })
      )
    }
    const fixture = await relaunchIsolatedE2EApp(
      userData,
      { platform },
      { ELECTRON_RENDERER_URL: '', AUTODOC_SKIP_INSTALL_POLICY: '1' }
    )
    try {
      const page = await fixture.electronApp.firstWindow()
      await page.setViewportSize({ width: 1040, height: 680 })
      await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
      const dismiss = page.getByRole('button', { name: '×', exact: true })
      if (await dismiss.isVisible()) await dismiss.click()
      await expect(page.getByText('Not enough memory', { exact: true })).toHaveCount(2)
      await page.getByText('Product planning', { exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('free RAM to finish transcription')
      await expect(
        page.getByText('Notes will appear here once the transcript is ready.')
      ).toHaveCount(0)
      if (platform === 'win32')
        await expect(page.getByRole('alert')).toContainText(
          'Available when checked: 1.9 GiB · Minimum to start: 2.5 GiB'
        )
      else await expect(page.getByText(/Available when checked/)).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('transcription-memory.png') })
      await page.reload()
      await expect(page.getByRole('alert')).toContainText('free RAM to finish transcription')
      await page.getByRole('button', { name: 'Transcript', exact: true }).click()
      await expect(page.getByRole('alert')).toBeVisible()
      // Observe real renderer-to-main retry IPC without starting model work in a UI test.
      await fixture.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('transcription:retry')
        ipcMain.handle('transcription:retry', (_event, id) => {
          ;(globalThis as any).memoryUiRetry = id
        })
      })
      await page.getByRole('button', { name: 'Retry transcription', exact: true }).click()
      await expect
        .poll(() => fixture.electronApp.evaluate(() => (globalThis as any).memoryUiRetry))
        .toBe('memory-transcription')

      await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
      await page.getByText('Design review', { exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('free RAM to generate notes')
      await expect(page.getByRole('alert')).toContainText(
        'Available when checked: 1.2 GiB · Minimum to start: 3.4 GiB'
      )
      await page.screenshot({ path: testInfo.outputPath('notes-memory.png') })
      await page.getByRole('button', { name: 'View transcript', exact: true }).click()
      await expect(
        page.getByText('We agreed to finish the updated design by Thursday.')
      ).toBeVisible()
      await page.getByRole('button', { name: 'Notes', exact: true }).click()
      await fixture.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('segmentation:retry')
        ipcMain.handle('segmentation:retry', (_event, id) => {
          ;(globalThis as any).memoryUiRetry = id
        })
      })
      await page.getByRole('button', { name: 'Retry notes', exact: true }).click()
      await expect
        .poll(() => fixture.electronApp.evaluate(() => (globalThis as any).memoryUiRetry))
        .toBe('memory-notes')

      await page.getByRole('link', { name: 'AI Notes', exact: true }).click()
      await page.getByText('Other failure', { exact: true }).click()
      await expect(page.getByText('Failed — Retry', { exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    } finally {
      await fixture.cleanup()
    }
  })
}
