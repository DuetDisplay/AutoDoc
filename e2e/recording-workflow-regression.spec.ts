/**
 * Windows headed recording regression:
 * pnpm run build; pnpm run test:e2e:headed -- e2e/recording-workflow-regression.spec.ts
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { RecordingEntry } from '../src/shared/types'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  installStableScreenshotBackground,
  relaunchIsolatedE2EApp
} from './helpers/electron-app'

const ARTIFACT_DIR = path.join(process.cwd(), 'artifacts', 'recording-regression')
const FFMPEG_PATH = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const E2E_ENV = {
  AUTODOC_E2E_FFMPEG_PATH: FFMPEG_PATH,
  AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1'
}
const WINDOWS_SCENARIO = {
  platform: 'win32' as const,
  permissions: { microphone: true, screen: true }
}

async function getRecordings(page: Page): Promise<RecordingEntry[]> {
  return await page.evaluate(async () => {
    return await window.electronAPI.invoke('recording:list')
  })
}

async function waitForOneFinalizedRecording(page: Page): Promise<RecordingEntry> {
  await expect
    .poll(async () => {
      const recordings = await getRecordings(page)
      return recordings.length === 1 && recordings[0]?.isFinalizing === false
    })
    .toBe(true)
  return (await getRecordings(page))[0]
}

async function startRecording(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Record$/ }).click()
  await page.locator('button').filter({ hasText: 'E2E Display' }).first().click()
  await expect(page.getByRole('button', { name: /^Stop Recording$/ })).toBeVisible()
}

test.beforeAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
})

test('single-segment manual stop finalizes, opens video detail, and survives relaunch', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-recording-regression-'))
  const firstApp = await relaunchIsolatedE2EApp(userDataDir, WINDOWS_SCENARIO, E2E_ENV)
  let relaunchedApp: Awaited<ReturnType<typeof relaunchIsolatedE2EApp>> | null = null

  try {
    const page = await firstApp.electronApp.firstWindow()
    await completeOnboarding(page)
    await installStableScreenshotBackground(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await startRecording(page)
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '01-single-segment-recording.png'),
      fullPage: true
    })

    await page.waitForTimeout(1_500)
    await page.getByRole('button', { name: /^Stop Recording$/ }).click()
    await page.getByRole('link', { name: 'AI Notes' }).click()

    const wrapping = page.getByText('Wrapping up recording...')
    if (await wrapping.isVisible().catch(() => false)) {
      await page.screenshot({
        path: path.join(ARTIFACT_DIR, '02-single-segment-wrapping.png'),
        fullPage: true
      })
    }

    const recording = await waitForOneFinalizedRecording(page)
    await expect(page.getByText(recording.title)).toBeVisible()
    await expect(wrapping).toBeHidden()
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '03-single-segment-finalized.png'),
      fullPage: true
    })

    await page.getByText(recording.title).click()
    await page.getByRole('button', { name: 'Transcript' }).click()
    await expect(page.locator('video')).toBeVisible()
    const detail = await page.evaluate(async (meetingId) => {
      return await window.electronAPI.invoke('recording:get-detail', meetingId)
    }, recording.meetingId)
    expect(detail.isFinalizing).toBe(false)
    expect(detail.videoProcessingFailed).not.toBe(true)
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '04-single-segment-detail.png'),
      fullPage: true
    })

    await firstApp.electronApp.close()
    relaunchedApp = await relaunchIsolatedE2EApp(userDataDir, WINDOWS_SCENARIO, E2E_ENV)
    const relaunchedPage = await relaunchedApp.electronApp.firstWindow()
    await installStableScreenshotBackground(relaunchedPage)
    await relaunchedPage.getByRole('link', { name: 'AI Notes' }).click()
    await expect(relaunchedPage.getByText(recording.title)).toBeVisible()
    await expect(relaunchedPage.getByText('Wrapping up recording...')).toBeHidden()
    await relaunchedPage.screenshot({
      path: path.join(ARTIFACT_DIR, '05-single-segment-reopened.png'),
      fullPage: true
    })
  } finally {
    if (relaunchedApp) {
      await relaunchedApp.cleanup()
    } else {
      await firstApp.cleanup()
    }
  }
})

test('rapid manual abort does not leave a wrapping-up meeting wedged', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-rapid-abort-'))
  const app = await relaunchIsolatedE2EApp(userDataDir, WINDOWS_SCENARIO, E2E_ENV)

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installStableScreenshotBackground(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await startRecording(page)
    await page.getByRole('button', { name: /^Stop Recording$/ }).click()
    await page.getByRole('link', { name: 'AI Notes' }).click()

    await expect
      .poll(async () => {
        const recordings = await getRecordings(page)
        return recordings.every((recording) => recording.isFinalizing === false)
      })
      .toBe(true)
    await expect(page.getByText('Wrapping up recording...')).toBeHidden()
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '06-rapid-abort-not-wedged.png'),
      fullPage: true
    })
  } finally {
    await app.cleanup()
  }
})

test('device-change multi-segment recording succeeds and clears finalizing', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-multi-segment-'))
  const app = await relaunchIsolatedE2EApp(userDataDir, WINDOWS_SCENARIO, E2E_ENV)

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installStableScreenshotBackground(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await startRecording(page)
    await page.waitForTimeout(1_000)
    await page.evaluate(() => {
      const qaWindow = window as typeof window & { __qaSwitchDefaultMic: () => void }
      qaWindow.__qaSwitchDefaultMic()
    })
    await page.waitForTimeout(1_500)
    await page.getByRole('button', { name: /^Stop Recording$/ }).click()
    await page.getByRole('link', { name: 'AI Notes' }).click()

    const recording = await waitForOneFinalizedRecording(page)
    const detail = await page.evaluate(async (meetingId) => {
      return await window.electronAPI.invoke('recording:get-detail', meetingId)
    }, recording.meetingId)
    const media = await page.evaluate(async (meetingId) => {
      return await window.electronAPI.invoke('recording:get-media', meetingId)
    }, recording.meetingId)

    expect(detail).toMatchObject({ isFinalizing: false })
    expect(detail.videoProcessingFailed).not.toBe(true)
    expect(media.hasVideo).toBe(true)
    await expect(page.getByText(recording.title)).toBeVisible()
    await expect(page.getByText('Wrapping up recording...')).toBeHidden()
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '07-multi-segment-finalized.png'),
      fullPage: true
    })

    console.log(`Recording regression screenshots: ${ARTIFACT_DIR}`)
  } finally {
    await app.cleanup()
  }
})
