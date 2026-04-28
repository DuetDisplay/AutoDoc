import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  completeOnboarding,
  launchIsolatedE2EApp,
  launchIsolatedExternalE2EApp,
} from './helpers/electron-app'

const V019_APP_ROOT = '/tmp/autodoc-v0.1.19-src'
const RECORDING_TITLE = 'AD-70 seeded recording'

const MARKERS = {
  whisperModel: ['models', 'ggml-large-v3.bin'],
  recording: ['recordings', 'meeting-1', 'audio.webm'],
  transcript: ['recordings', 'meeting-1', 'transcript.json'],
  metadata: ['recordings', 'meeting-1', 'metadata.json'],
} as const

async function seedReproStorage(userDataDir: string): Promise<void> {
  const files = [
    path.join(userDataDir, ...MARKERS.whisperModel),
    path.join(userDataDir, ...MARKERS.recording),
    path.join(userDataDir, ...MARKERS.transcript),
    path.join(userDataDir, ...MARKERS.metadata),
  ]

  for (const filePath of files) {
    await mkdir(path.dirname(filePath), { recursive: true })
  }

  await writeFile(path.join(userDataDir, ...MARKERS.whisperModel), Buffer.alloc(1024))
  await writeFile(path.join(userDataDir, ...MARKERS.recording), Buffer.alloc(1024))
  await writeFile(path.join(userDataDir, ...MARKERS.transcript), JSON.stringify([]))
  await writeFile(
    path.join(userDataDir, ...MARKERS.metadata),
    JSON.stringify({
      sourceName: 'Screen 1',
      startedAt: Date.UTC(2026, 3, 27, 14, 13, 0),
      stoppedAt: Date.UTC(2026, 3, 27, 14, 14, 0),
      durationSeconds: 60,
      customTitle: RECORDING_TITLE,
    }),
  )
}

async function openSeededRecording(page: Page): Promise<void> {
  await completeOnboarding(page)
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = '#/recordings'
  })
  await expect(page.getByRole('heading', { name: 'AI Notes' })).toBeVisible()
  await expect(page.getByText(RECORDING_TITLE)).toBeVisible()
}

async function verifyDeletePreservesModel(
  page: Page,
  userDataDir: string,
): Promise<void> {
  await openSeededRecording(page)
  await page.evaluate(async () => {
    await window.electronAPI.invoke('recording:delete', 'meeting-1')
  })
  await expect(page.getByText(RECORDING_TITLE)).toHaveCount(0)

  expect(existsSync(path.join(userDataDir, ...MARKERS.whisperModel))).toBe(true)
  expect(existsSync(path.join(userDataDir, ...MARKERS.recording))).toBe(false)
}

test.describe('AD-70 delete repro', () => {
  test('current branch delete flow preserves the speech model marker', async () => {
    const app = await launchIsolatedE2EApp({
      platform: 'darwin',
    })

    try {
      await seedReproStorage(app.userDataDir)
      const page = await app.electronApp.firstWindow()
      await verifyDeletePreservesModel(page, app.userDataDir)
    } finally {
      await app.cleanup()
    }
  })

  test('v0.1.19 delete flow preserves the speech model marker under the same mocked setup', async () => {
    const app = await launchIsolatedExternalE2EApp(V019_APP_ROOT, {
      platform: 'darwin',
    })

    try {
      await seedReproStorage(app.userDataDir)
      const page = await app.electronApp.firstWindow()
      await verifyDeletePreservesModel(page, app.userDataDir)
    } finally {
      await app.cleanup()
    }
  })
})
