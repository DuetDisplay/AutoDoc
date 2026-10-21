import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchRealSetupApp } from './helpers/electron-app'

test('a non-English meeting with exhausted missing-model retries downloads its model and transcribes', async () => {
  test.skip(
    process.env.AUTODOC_RUN_REAL_MODEL_READINESS_TESTS !== '1',
    'Opt in to downloading the real speech model.'
  )
  test.skip(
    process.platform !== 'darwin' || process.arch !== 'arm64',
    'Requires Apple Silicon and a French system voice.'
  )
  test.setTimeout(10 * 60_000)
  const profile = mkdtempSync(path.join(os.tmpdir(), 'autodoc-real-model-readiness-'))
  const meetingId = 'french-missing-model'
  const dir = path.join(profile, 'recordings', meetingId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(profile, 'autodoc-prefs.json'),
    JSON.stringify({
      onboardingComplete: true,
      onboardingLanguageConfirmed: true,
      launchAtLogin: false,
      analyticsConsent: false,
      diagnosticLogUploadConsent: false,
      meetingLanguage: 'fr'
    })
  )
  const aiff = path.join(profile, 'speech.aiff')
  execFileSync('/usr/bin/say', [
    '-v',
    'Thomas',
    '-o',
    aiff,
    'Nous avons décidé de lancer le portail vendredi. Marie doit préparer la présentation avant jeudi. Pierre vérifiera les résultats et enverra son rapport lundi. Le budget du projet est de cinq mille euros. La prochaine réunion aura lieu mardi matin.'
  ])
  execFileSync(
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
    ['-y', '-i', aiff, '-c:a', 'libopus', path.join(dir, 'mic.webm')],
    { stdio: 'pipe' }
  )
  writeFileSync(
    path.join(dir, 'metadata.json'),
    JSON.stringify({
      sourceName: 'Model readiness regression',
      startedAt: Date.now() - 60_000,
      stoppedAt: Date.now(),
      durationSeconds: 30,
      meetingLanguage: 'fr'
    })
  )
  writeFileSync(
    path.join(dir, 'transcript.error'),
    JSON.stringify({
      error:
        'The speech model is missing or incomplete. Select the meeting language in Settings to download it.',
      retries: 22
    })
  )
  const app = await launchRealSetupApp(undefined, {
    userDataDir: profile,
    cleanupUserDataDir: true
  })
  try {
    const page = await app.electronApp.firstWindow()
    let downloading = false
    await expect
      .poll(
        async () => {
          const status = await page.evaluate(
            (id) => window.electronAPI.invoke('transcription:get-status', id),
            meetingId
          )
          if (status === 'downloading') downloading = true
          return status
        },
        { timeout: 9 * 60_000, intervals: [1000, 2000, 5000] }
      )
      .toBe('complete')
    expect(downloading).toBe(true)
    const setup = await page.evaluate(() => window.electronAPI.invoke('whisper:get-setup-status'))
    expect(setup.phase).toBe('ready')
    const transcript = await page.evaluate(
      (id) => window.electronAPI.invoke('transcription:get-transcript', id),
      meetingId
    )
    expect(transcript.map((segment) => segment.text).join(' ').length).toBeGreaterThan(40)
    expect(existsSync(path.join(dir, 'transcript.error'))).toBe(false)
  } finally {
    await app.cleanup()
  }
})
