import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { completeOnboarding, launchRealSetupApp } from './helpers/electron-app'

function seedCompletedTranscript(userDataDir: string, meetingId: string, startedAt: number): void {
  const meetingDir = path.join(userDataDir, 'recordings', meetingId)
  mkdirSync(meetingDir, { recursive: true })
  writeFileSync(path.join(meetingDir, 'mic.webm'), 'qa-audio')
  writeFileSync(
    path.join(meetingDir, 'metadata.json'),
    JSON.stringify({
      sourceName: 'QA Meeting',
      startedAt,
      stoppedAt: startedAt + 60_000,
      durationSeconds: 60
    })
  )
  writeFileSync(
    path.join(meetingDir, 'transcript.json'),
    JSON.stringify([
      {
        id: `${meetingId}-0`,
        meetingId,
        speaker: 'Chris',
        text: 'The team reviewed the Windows Ollama setup issue and agreed that notes should wait while the shared setup is downloading.',
        startMs: 0,
        endMs: 20_000,
        confidence: 0.9
      },
      {
        id: `${meetingId}-1`,
        meetingId,
        speaker: 'Pat',
        text: 'If the automatic setup retries are exhausted, each waiting recording should show a retryable notes failure instead of hanging.',
        startMs: 25_000,
        endMs: 55_000,
        confidence: 0.9
      }
    ])
  )
}

test.describe('AD-76 Windows Ollama setup coordination', () => {
  test('keeps queued notes waiting during background Ollama retries, then fails after retry budget', async () => {
    test.skip(process.platform !== 'win32', 'AD-76 repro is Windows-only.')
    test.setTimeout(60_000)

    const userDataDir = path.join(os.tmpdir(), `autodoc-ad76-${Date.now()}`)
    rmSync(userDataDir, { recursive: true, force: true })
    mkdirSync(userDataDir, { recursive: true })
    seedCompletedTranscript(userDataDir, 'ad76-meeting-1', Date.now() - 120_000)
    seedCompletedTranscript(userDataDir, 'ad76-meeting-2', Date.now() - 60_000)

    const app = await launchRealSetupApp(
      {
        AUTODOC_TEST_OLLAMA_SETUP_SEQUENCE:
          'download-fail,download-fail,download-fail,download-fail',
        AUTODOC_TEST_OLLAMA_SETUP_RETRY_DELAYS_MS: '0,1000,1000,1000'
      },
      { userDataDir, cleanupUserDataDir: true }
    )

    try {
      const page = await app.electronApp.firstWindow()
      await completeOnboarding(page)
      await page.getByRole('link', { name: 'AI Notes' }).click()
      await expect(page.getByRole('heading', { name: 'AI Notes' })).toBeVisible()
      await expect(page.getByText(/QA Meeting|Recording/).first()).toBeVisible()

      await expect(page.getByText(/Downloading Ollama runtime/i).first()).toBeVisible({
        timeout: 5_000
      })
      await expect(page.getByText(/Notes failed/i)).toHaveCount(0)

      await expect
        .poll(async () => await page.getByText(/Notes failed/i).count(), {
          timeout: 15_000
        })
        .toBe(2)
    } finally {
      await app.cleanup()
      if (existsSync(userDataDir)) {
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  })

  test('automatically runs queued notes when a background Ollama retry succeeds', async () => {
    test.skip(process.platform !== 'win32', 'AD-76 repro is Windows-only.')
    test.setTimeout(60_000)

    const userDataDir = path.join(os.tmpdir(), `autodoc-ad76-success-${Date.now()}`)
    rmSync(userDataDir, { recursive: true, force: true })
    mkdirSync(userDataDir, { recursive: true })
    seedCompletedTranscript(userDataDir, 'ad76-success-meeting-1', Date.now() - 120_000)
    seedCompletedTranscript(userDataDir, 'ad76-success-meeting-2', Date.now() - 60_000)

    const app = await launchRealSetupApp(
      {
        AUTODOC_TEST_OLLAMA_SETUP_SEQUENCE: 'download-fail,ready',
        AUTODOC_TEST_OLLAMA_SETUP_RETRY_DELAYS_MS: '0,1000',
        AUTODOC_TEST_OLLAMA_SUMMARY_MODE: 'fixed-success'
      },
      { userDataDir, cleanupUserDataDir: true }
    )

    try {
      const page = await app.electronApp.firstWindow()
      await completeOnboarding(page)
      await page.getByRole('link', { name: 'AI Notes' }).click()
      await expect(page.getByRole('heading', { name: 'AI Notes' })).toBeVisible()
      await expect(page.getByText(/QA Meeting|Recording/).first()).toBeVisible()

      await expect(page.getByText(/Downloading Ollama runtime/i).first()).toBeVisible({
        timeout: 5_000
      })
      await expect(page.getByText(/Notes failed/i)).toHaveCount(0)

      await expect
        .poll(async () => await page.getByText(/Notes ready/i).count(), {
          timeout: 15_000
        })
        .toBe(2)
      await expect(page.getByText(/Notes failed/i)).toHaveCount(0)

      const generatedSegments = await page.evaluate(async () => {
        const first = await window.electronAPI.invoke(
          'segmentation:get-segments',
          'ad76-success-meeting-1'
        )
        const second = await window.electronAPI.invoke(
          'segmentation:get-segments',
          'ad76-success-meeting-2'
        )
        return [first, second]
      })

      for (const segments of generatedSegments) {
        expect(segments?.actionItems?.[0]).toMatchObject({
          title: 'Coordinate Ollama setup',
          content: 'AutoDoc should keep notes waiting while shared Ollama setup completes.'
        })
      }
    } finally {
      await app.cleanup()
      if (existsSync(userDataDir)) {
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  })
})
