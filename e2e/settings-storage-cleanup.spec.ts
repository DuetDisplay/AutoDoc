import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { completeOnboarding, launchIsolatedE2EApp } from './helpers/electron-app'

const MARKERS = {
  whisperModel: ['models', 'ggml-large-v3.bin'],
  ffmpeg: ['models', 'ffmpeg'],
  ollamaBlob: ['ollama-data', 'blobs', 'sha256-test-model'],
  python: ['python-env', 'bin', 'python3'],
  recording: ['recordings', 'meeting-1', 'audio.webm'],
  log: ['logs', 'autodoc.log'],
} as const

async function seedManagedStorage(userDataDir: string): Promise<void> {
  const files = [
    path.join(userDataDir, ...MARKERS.whisperModel),
    path.join(userDataDir, ...MARKERS.ffmpeg),
    path.join(userDataDir, ...MARKERS.ollamaBlob),
    path.join(userDataDir, ...MARKERS.python),
    path.join(userDataDir, ...MARKERS.recording),
    path.join(userDataDir, ...MARKERS.log),
  ]

  for (const filePath of files) {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.alloc(1024))
  }
}

async function openSettings(page: Page): Promise<void> {
  await completeOnboarding(page)
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible()
  await page.evaluate(() => {
    window.location.hash = '#/settings'
  })
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
}

async function acceptNextDialog(page: Page): Promise<void> {
  const dialog = await page.waitForEvent('dialog')
  await dialog.accept()
}

test('macOS settings cleanup removes managed downloads and keeps recordings', async () => {
  const app = await launchIsolatedE2EApp({
    platform: 'darwin',
  })

  try {
    await seedManagedStorage(app.userDataDir)
    const page = await app.electronApp.firstWindow()

    await openSettings(page)
    await expect(page.getByText(/deleting autodoc from applications does not remove local data on macos/i)).toBeVisible()
    await expect(page.getByText('Downloaded AI components', { exact: true })).toBeVisible()

    const acceptDialogPromise = acceptNextDialog(page)
    await page.getByRole('button', { name: /remove downloaded ai components/i }).click()
    await acceptDialogPromise

    await expect(page.getByText(/downloaded ai components removed/i)).toBeVisible()
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.whisperModel))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.ffmpeg))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.ollamaBlob))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.python))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.recording))).toBe(true)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.log))).toBe(true)
  } finally {
    await app.cleanup()
  }
})

test('Windows settings cleanup shows Windows guidance and removes managed downloads', async () => {
  const app = await launchIsolatedE2EApp({
    platform: 'win32',
  })

  try {
    await seedManagedStorage(app.userDataDir)
    const page = await app.electronApp.firstWindow()

    await openSettings(page)
    await expect(page.getByText(/windows uninstall can optionally remove autodoc local data/i)).toBeVisible()

    const acceptDialogPromise = acceptNextDialog(page)
    await page.getByRole('button', { name: /remove downloaded ai components/i }).click()
    await acceptDialogPromise

    await expect(page.getByText(/downloaded ai components removed/i)).toBeVisible()
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.whisperModel))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.ffmpeg))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.ollamaBlob))).toBe(false)
    expect(existsSync(path.join(app.userDataDir, ...MARKERS.recording))).toBe(true)
  } finally {
    await app.cleanup()
  }
})
