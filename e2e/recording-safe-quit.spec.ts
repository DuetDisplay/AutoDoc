import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  installFakeCaptureDevices,
  relaunchIsolatedE2EApp
} from './helpers/electron-app'

test('quitting before the first capture chunk saves audio and survives relaunch', async () => {
  test.setTimeout(120_000)
  const profile = mkdtempSync(path.join(os.tmpdir(), 'autodoc-safe-quit-'))
  const env = {
    AUTODOC_E2E_FFMPEG_PATH: path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    ),
    AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1'
  }
  const scenario = {
    platform: process.platform === 'win32' ? ('win32' as const) : ('darwin' as const),
    permissions: { microphone: true, screen: true }
  }
  const first = await relaunchIsolatedE2EApp(profile, scenario, env)
  let second: Awaited<ReturnType<typeof relaunchIsolatedE2EApp>> | undefined
  try {
    const page = await first.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await page.getByRole('button', { name: /^Record$/ }).click()
    await page.locator('button').filter({ hasText: 'E2E Display' }).first().click()
    await expect(page.getByRole('button', { name: /^Stop Recording$/ })).toBeVisible()
    const install = await page.evaluate(() => window.electronAPI.invoke('updater:install'))
    expect(install.blockedReason).toContain('Finish your recording')
    expect(
      await page.evaluate(
        async () => (await window.electronAPI.invoke('recording:get-state')).isRecording
      )
    ).toBe(true)
    await page.waitForTimeout(600)
    const process = first.electronApp.process()
    await first.electronApp.evaluate(({ app }) => {
      app.quit()
    })
    await expect.poll(() => process.exitCode, { timeout: 60_000 }).not.toBeNull()
    const base = path.join(profile, 'recordings')
    const meeting = readdirSync(base)[0]
    expect(meeting).toBeTruthy()
    expect(
      existsSync(path.join(base, meeting, 'mic.webm')) ||
        existsSync(path.join(base, meeting, 'system.webm'))
    ).toBe(true)
    second = await relaunchIsolatedE2EApp(profile, scenario, env)
    const reopened = await second.electronApp.firstWindow()
    const recordings = await reopened.evaluate(() => window.electronAPI.invoke('recording:list'))
    expect(recordings).toHaveLength(1)
    expect(recordings[0].hasAudio).toBe(true)
    expect(recordings[0].isFinalizing).toBe(false)
  } finally {
    await (second ?? first).cleanup()
  }
})

test('relaunch recovers an interrupted recording from numbered capture files', async () => {
  test.setTimeout(120_000)
  const profile = mkdtempSync(path.join(os.tmpdir(), 'autodoc-crash-recovery-'))
  const env = {
    AUTODOC_E2E_FFMPEG_PATH: path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    ),
    AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1',
    AUTODOC_E2E_RECOVER_INTERRUPTED_RECORDINGS: '1'
  }
  const scenario = {
    platform: process.platform === 'win32' ? ('win32' as const) : ('darwin' as const),
    permissions: { microphone: true, screen: true }
  }
  const first = await relaunchIsolatedE2EApp(profile, scenario, env)
  let second: Awaited<ReturnType<typeof relaunchIsolatedE2EApp>> | undefined
  try {
    const page = await first.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await page.getByRole('button', { name: /^Record$/ }).click()
    await page.locator('button').filter({ hasText: 'E2E Display' }).first().click()
    await expect(page.getByRole('button', { name: /^Stop Recording$/ })).toBeVisible()
    const base = path.join(profile, 'recordings')
    await expect
      .poll(
        () =>
          readdirSync(path.join(base, readdirSync(base)[0])).some((name) =>
            /^mic-\d+\.webm$/.test(name)
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    const proc = first.electronApp.process()
    proc.kill('SIGKILL')
    await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null).toBe(true)
    second = await relaunchIsolatedE2EApp(profile, scenario, env)
    const reopened = await second.electronApp.firstWindow()
    await expect
      .poll(
        async () => {
          const recordings = await reopened.evaluate(() =>
            window.electronAPI.invoke('recording:list')
          )
          return recordings.length === 1 && recordings[0].hasAudio && !recordings[0].isFinalizing
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    const meeting = readdirSync(base)[0]
    expect(existsSync(path.join(base, meeting, 'mic.webm'))).toBe(true)
  } finally {
    await (second ?? first).cleanup()
  }
})
