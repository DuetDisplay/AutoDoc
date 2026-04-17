import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { jumpToOnboardingStep, launchRealSetupApp } from './helpers/electron-app'

const RUN_REAL_DOWNLOAD_TESTS = process.env.AUTODOC_RUN_REAL_DOWNLOAD_TESTS === '1'
const REAL_DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000
const POLL_INTERVAL_MS = 5000

async function waitForSetupReady(
  page: Page,
  channel: 'whisper:get-setup-status' | 'ollama:get-setup-status',
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const status = await page.evaluate(async (invokeChannel) => {
      return await window.electronAPI.invoke(invokeChannel)
    }, channel)

    if (status.phase === 'ready') {
      return status
    }

    if (status.phase === 'error') {
      throw new Error(`${channel} failed during real setup: ${status.error ?? 'Unknown error'}`)
    }

    await page.waitForTimeout(POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${channel} to become ready.`)
}

async function expectAnyHeading(page: Page, names: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    for (const name of names) {
      if (await page.getByRole('heading', { name }).isVisible().catch(() => false)) {
        return
      }
    }

    await page.waitForTimeout(500)
  }

  throw new Error(`Timed out waiting for one of these headings: ${names.join(', ')}`)
}

async function clickContinueIfVisible(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', { name: /^continue$/i })
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click()
  }
}

function expectWhisperArtifacts(storagePath: string): void {
  const modelsDir = path.join(storagePath, 'models')
  const whisperBinary = path.join(modelsDir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cpp')
  const ffmpegBinary = path.join(modelsDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

  expect(existsSync(whisperBinary)).toBeTruthy()
  expect(existsSync(ffmpegBinary)).toBeTruthy()

  const modelFiles = readdirSync(modelsDir).filter((name) => /^ggml-.*\.bin$/i.test(name))
  expect(modelFiles.length).toBeGreaterThan(0)
}

function hasFilesRecursively(dir: string): boolean {
  if (!existsSync(dir)) return false

  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry)
    const stat = statSync(entryPath)
    if (stat.isFile()) return true
    if (stat.isDirectory() && hasFilesRecursively(entryPath)) return true
  }

  return false
}

function expectOllamaArtifacts(storagePath: string): void {
  const runtimeDir = path.join(storagePath, 'models', 'ollama-runtime')
  const runtimeBinary = path.join(runtimeDir, process.platform === 'win32' ? 'ollama.exe' : 'ollama')
  const ollamaDataDir = path.join(storagePath, 'ollama-data')

  expect(existsSync(runtimeBinary)).toBeTruthy()
  expect(hasFilesRecursively(ollamaDataDir)).toBeTruthy()
}

test.describe('real managed setup downloads', () => {
  test('macOS clean install downloads managed Whisper and Ollama successfully', async () => {
    test.skip(!RUN_REAL_DOWNLOAD_TESTS, 'Set AUTODOC_RUN_REAL_DOWNLOAD_TESTS=1 to run real download integration tests.')
    test.skip(process.platform !== 'darwin', 'This real-download integration test only runs on macOS hosts.')
    test.setTimeout(REAL_DOWNLOAD_TIMEOUT_MS)

    const app = await launchRealSetupApp()

    try {
      const page = await app.electronApp.firstWindow()

      await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

      await jumpToOnboardingStep(page, 7)
      await expectAnyHeading(page, ['Setting Up Transcription', 'Transcription Ready', 'Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)

      await waitForSetupReady(page, 'whisper:get-setup-status', REAL_DOWNLOAD_TIMEOUT_MS)
      await expectAnyHeading(page, ['Transcription Ready', 'Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)
      await clickContinueIfVisible(page)

      await waitForSetupReady(page, 'ollama:get-setup-status', REAL_DOWNLOAD_TIMEOUT_MS)
      await expectAnyHeading(page, ['Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)

      const runtimeInfo = await page.evaluate(async () => {
        return await window.electronAPI.invoke('app:get-runtime-info')
      })

      expectWhisperArtifacts(runtimeInfo.storagePath)
      expectOllamaArtifacts(runtimeInfo.storagePath)
    } finally {
      await app.cleanup()
    }
  })

  test('Windows clean install downloads managed Whisper and Ollama successfully', async () => {
    test.skip(!RUN_REAL_DOWNLOAD_TESTS, 'Set AUTODOC_RUN_REAL_DOWNLOAD_TESTS=1 to run real download integration tests.')
    test.skip(process.platform !== 'win32', 'This real-download integration test only runs on Windows hosts.')
    test.setTimeout(REAL_DOWNLOAD_TIMEOUT_MS)

    const app = await launchRealSetupApp()

    try {
      const page = await app.electronApp.firstWindow()

      await expect(page.getByRole('heading', { name: 'AutoDoc' })).toBeVisible()

      await jumpToOnboardingStep(page, 7)
      await expectAnyHeading(page, ['Setting Up Transcription', 'Transcription Ready', 'Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)

      await waitForSetupReady(page, 'whisper:get-setup-status', REAL_DOWNLOAD_TIMEOUT_MS)
      await expectAnyHeading(page, ['Transcription Ready', 'Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)
      await clickContinueIfVisible(page)

      await waitForSetupReady(page, 'ollama:get-setup-status', REAL_DOWNLOAD_TIMEOUT_MS)
      await expectAnyHeading(page, ['Setting Up AI', 'AI Model Ready', 'Help Improve AutoDoc', "You're All Set"], 10_000)

      const runtimeInfo = await page.evaluate(async () => {
        return await window.electronAPI.invoke('app:get-runtime-info')
      })

      expectWhisperArtifacts(runtimeInfo.storagePath)
      expectOllamaArtifacts(runtimeInfo.storagePath)
    } finally {
      await app.cleanup()
    }
  })
})
