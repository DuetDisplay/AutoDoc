import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeE2EAppKeepingUserData } from './helpers/electron-app'

test('isolated test startup and cleanup leave legacy home data untouched', async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'autodoc-legacy-isolation-'))
  const home = path.join(sandbox, 'home'),
    profile = path.join(sandbox, 'profile')
  const legacy = path.join(home, 'AutoDoc', 'recordings', 'synthetic-legacy-meeting')
  mkdirSync(legacy, { recursive: true })
  mkdirSync(profile)
  writeFileSync(
    path.join(legacy, 'metadata.json'),
    JSON.stringify({
      sourceName: 'SYNTHETIC SENTINEL',
      startedAt: 1,
      stoppedAt: 2,
      durationSeconds: 1
    })
  )
  writeFileSync(
    path.join(profile, 'autodoc-prefs.json'),
    JSON.stringify({
      onboardingComplete: true,
      onboardingLanguageConfirmed: true,
      analyticsConsent: false,
      diagnosticLogUploadConsent: false
    })
  )
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [
        '-r',
        path.resolve('e2e/helpers/synthetic-home.cjs'),
        process.cwd(),
        `--autodoc-e2e-profile=${profile}`
      ],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTODOC_E2E: '1',
        AUTODOC_TEST_MODE: '1',
        AUTODOC_TEST_USER_DATA_DIR: profile,
        AUTODOC_E2E_SYNTHETIC_HOME: home
      }
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Upcoming', exact: true })).toBeVisible()
    expect(await app.evaluate(({ app }) => app.getPath('home'))).toBe(home)
    expect(existsSync(path.join(legacy, 'metadata.json'))).toBe(true)
    expect(existsSync(path.join(profile, 'recordings', 'synthetic-legacy-meeting'))).toBe(false)
    await closeE2EAppKeepingUserData(app, profile)
    app = undefined
    rmSync(profile, { recursive: true, force: true })
    expect(existsSync(path.join(legacy, 'metadata.json'))).toBe(true)
  } finally {
    if (app) await closeE2EAppKeepingUserData(app, profile)
    rmSync(sandbox, { recursive: true, force: true })
  }
})
