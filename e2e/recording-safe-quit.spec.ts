import { mkdtempSync, readdirSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    const audio = path.join(
      base,
      meeting,
      existsSync(path.join(base, meeting, 'mic.webm')) ? 'mic.webm' : 'system.webm'
    )
    expect(statSync(audio).size).toBeGreaterThan(0)
    execFileSync(env.AUTODOC_E2E_FFMPEG_PATH, ['-v', 'error', '-i', audio, '-f', 'null', '-'], {
      stdio: 'pipe'
    })
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
  const keyState = () => {
    const localStatePath = path.join(profile, 'Local State')
    let localStateHasOsCryptKey = false
    let dpapiBackupExists = false
    try {
      localStateHasOsCryptKey = Boolean(
        JSON.parse(readFileSync(localStatePath, 'utf8'))?.os_crypt?.encrypted_key
      )
    } catch {
      // Missing Local State is the cold-profile failure being exercised.
    }
    try {
      dpapiBackupExists =
        typeof JSON.parse(readFileSync(path.join(profile, 'autodoc-encryption.json'), 'utf8'))
          ?.encryption_key_dpapi === 'string'
    } catch {
      // Report only backup presence; never expose the protected value.
    }
    return {
      appKeyStoreExists: existsSync(path.join(profile, 'autodoc-encryption.json')),
      localStateExists: existsSync(localStatePath),
      localStateHasOsCryptKey,
      dpapiBackupExists
    }
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
          readdirSync(path.join(base, readdirSync(base)[0])).some(
            (name) =>
              /^mic-\d+\.webm$/.test(name) &&
              statSync(path.join(base, readdirSync(base)[0], name)).size > 0
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    const proc = first.electronApp.process()
    const mainPid = await first.electronApp.evaluate(() => process.pid)
    if (process.platform === 'win32') expect(keyState().dpapiBackupExists).toBe(true)
    console.log('key-durability-before-termination', keyState())
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/pid', String(mainPid), '/t', '/f'], { windowsHide: true })
    } else {
      proc.kill('SIGKILL')
    }
    await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null).toBe(true)
    if (process.platform === 'win32') {
      // Make the verified loss of Chromium's master key deterministic, even if
      // this host persisted Local State before the abrupt termination.
      rmSync(path.join(profile, 'Local State'), { force: true })
    }
    console.log('key-durability-after-termination', keyState())
    second = await relaunchIsolatedE2EApp(profile, scenario, env)
    const reopened = await second.electronApp.firstWindow()
    console.log('key-durability-after-relaunch', keyState())
    await expect
      .poll(
        async () => {
          const recordings = await reopened.evaluate(() =>
            window.electronAPI.invoke('recording:list')
          )
          const audio = path.join(base, recordings[0]?.meetingId ?? '', 'mic.webm')
          return (
            recordings.length === 1 &&
            recordings[0].hasAudio &&
            !recordings[0].isFinalizing &&
            existsSync(audio) &&
            statSync(audio).size > 0
          )
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
