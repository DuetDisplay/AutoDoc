import { test, expect, type Page } from '@playwright/test'
import { launchE2EApp, setWhisperStatus } from './helpers/electron-app'

async function reachTranscriptionStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: /get started/i }).click()
  await expect(page.getByRole('heading', { name: 'Private by Design' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'Notes That Think' })).toBeVisible()
  await page.getByRole('button', { name: /next/i }).click()
  await expect(page.getByRole('heading', { name: 'Connect Calendar' })).toBeVisible()
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page.getByRole('heading', { name: 'Setting Up Transcription' })).toBeVisible()
}

test('Windows onboarding reports the selected GPU accelerated transcription runtime', async () => {
  test.slow()

  const electronApp = await launchE2EApp({
    platform: 'win32',
    whisper: {
      status: {
        phase: 'downloading-whisper',
        percent: 17,
        backend: 'parakeet-gpu',
        backendLabel: 'GPU accelerated transcription'
      }
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await reachTranscriptionStep(page)
    await expect(
      page.getByText(/downloading GPU accelerated transcription\.\.\. 17%/i)
    ).toBeVisible()

    await setWhisperStatus(page, {
      phase: 'downloading-model',
      percent: 64,
      backend: 'parakeet-gpu',
      backendLabel: 'GPU accelerated transcription'
    })
    await expect(
      page.getByText(/downloading speech model for GPU accelerated transcription\.\.\. 64%/i)
    ).toBeVisible()
  } finally {
    await electronApp.close()
  }
})

test('Windows onboarding reports the selected CPU optimized transcription runtime', async () => {
  test.slow()

  const electronApp = await launchE2EApp({
    platform: 'win32',
    whisper: {
      status: {
        phase: 'downloading-whisper',
        percent: 23,
        backend: 'parakeet-cpu',
        backendLabel: 'CPU optimized transcription'
      }
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()
    await reachTranscriptionStep(page)
    await expect(page.getByText(/downloading CPU optimized transcription\.\.\. 23%/i)).toBeVisible()
  } finally {
    await electronApp.close()
  }
})
