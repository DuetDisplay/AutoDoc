import path from 'node:path'
import { expect, test } from '@playwright/test'
import packageMetadata from '../package.json'
import {
  closeE2EAppKeepingUserData,
  completeOnboarding,
  launchIsolatedE2EAppWithEnv,
  launchPackagedDefaultProfileApp,
  launchPackagedRealSetupApp,
  relaunchIsolatedE2EApp
} from './helpers/electron-app'

test('QA simulator drives the real first, reminder, suppression, and reset flows', async () => {
  const app = await launchIsolatedE2EAppWithEnv({
    AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com'
  })

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await page
      .getByTitle('Dismiss')
      .click({ timeout: 1_500 })
      .catch(() => {})

    await page.getByRole('link', { name: 'Settings' }).click()
    const simulator = page.getByRole('region', { name: 'Feedback prompt simulator' })
    await expect(simulator).toBeVisible()
    await expect(simulator.getByText('QA BUILD')).toBeVisible()
    await expect(simulator.getByText('Currently suppressed')).toBeVisible()
    await expect(page.getByText('Updates disabled in QA builds')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)

    await simulator.getByText('AI Notes', { exact: true }).click()
    await simulator.getByRole('button', { name: 'Show first prompt' }).click()
    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Maybe later' })).toBeVisible()
    await prompt.getByRole('button', { name: 'Maybe later' }).click()
    await expect(prompt).toHaveCount(0)

    await page.getByRole('link', { name: 'Settings' }).click()
    await page
      .getByRole('region', { name: 'Feedback prompt simulator' })
      .getByRole('button', { name: 'Show final reminder' })
      .click()
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Dismiss' })).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Maybe later' })).toHaveCount(0)
    await prompt.getByRole('button', { name: 'Dismiss' }).click()
    await expect(prompt).toHaveCount(0)

    await page.getByRole('link', { name: 'Settings' }).click()
    const reloadedSimulator = page.getByRole('region', { name: 'Feedback prompt simulator' })
    await reloadedSimulator.getByRole('button', { name: 'Set Don’t ask again' }).click()
    await expect(reloadedSimulator.getByText('Suppressed by Don’t ask again')).toBeVisible()
    await reloadedSimulator.getByRole('button', { name: 'Open selected surface' }).click()
    await expect(prompt).toHaveCount(0)

    await page.getByRole('link', { name: 'Settings' }).click()
    const resetSimulator = page.getByRole('region', { name: 'Feedback prompt simulator' })
    await resetSimulator.getByRole('button', { name: 'Reset natural eligibility' }).click()
    await expect(
      resetSimulator.getByText('Natural session and time thresholds are not met')
    ).toBeVisible()
  } finally {
    await app.cleanup()
  }
})

test('QA simulator exercises mail fallback and persists contact suppression across relaunch', async () => {
  const supportEnv = { AUTODOC_SUPPORT_EMAIL: 'team@getautodoc.com' }
  const app = await launchIsolatedE2EAppWithEnv(supportEnv)
  let relaunched: Awaited<ReturnType<typeof relaunchIsolatedE2EApp>> | null = null
  let originalClosed = false

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await page
      .getByTitle('Dismiss')
      .click({ timeout: 1_500 })
      .catch(() => {})
    await app.electronApp.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error('QA mail client unavailable')
      }
    })

    await page.getByRole('link', { name: 'Settings' }).click()
    await page
      .getByRole('region', { name: 'Feedback prompt simulator' })
      .getByRole('button', { name: 'Show first prompt' })
      .click()

    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await prompt.getByRole('button', { name: 'Share feedback' }).click()
    await expect(prompt.getByText('Mail app didn’t open.')).toBeVisible()
    await expect(prompt.getByText('team@getautodoc.com')).toBeVisible()
    await prompt.getByRole('button', { name: 'Copy email address' }).click()
    await expect(prompt).toHaveCount(0)

    const copiedAddress = await app.electronApp.evaluate(({ clipboard }) => clipboard.readText())
    expect(copiedAddress).toBe('team@getautodoc.com')

    await closeE2EAppKeepingUserData(app.electronApp, app.userDataDir)
    originalClosed = true
    relaunched = await relaunchIsolatedE2EApp(app.userDataDir, undefined, supportEnv)

    const relaunchedPage = await relaunched.electronApp.firstWindow()
    await relaunchedPage
      .getByTitle('Dismiss')
      .click({ timeout: 1_500 })
      .catch(() => {})
    await relaunchedPage.getByRole('link', { name: 'Settings' }).click()
    await expect(
      relaunchedPage
        .getByRole('region', { name: 'Feedback prompt simulator' })
        .getByText('Suppressed because support was already contacted')
    ).toBeVisible()
  } finally {
    if (relaunched) {
      await relaunched.cleanup()
    } else if (!originalClosed) {
      await app.cleanup()
    } else {
      await app.cleanup().catch(() => {})
    }
  }
})

const packagedQAApp = process.env.AUTODOC_QA_PACKAGED_APP
const checkDefaultProfile = process.env.AUTODOC_QA_DEFAULT_PROFILE_CHECK === '1'

test('packaged QA app uses the isolated default profile', async () => {
  test.skip(
    !packagedQAApp || !checkDefaultProfile,
    'Set AUTODOC_QA_PACKAGED_APP and AUTODOC_QA_DEFAULT_PROFILE_CHECK=1.'
  )
  const app = await launchPackagedDefaultProfileApp(packagedQAApp!)

  try {
    const identity = await app.electronApp.evaluate(({ app: electronApp }) => ({
      name: electronApp.getName(),
      appData: electronApp.getPath('appData'),
      userData: electronApp.getPath('userData')
    }))

    expect(identity.name).toBe('AutoDoc QA')
    expect(path.basename(identity.userData)).toBe('AutoDoc QA')
    expect(identity.userData).toBe(path.join(identity.appData, 'AutoDoc QA'))
    expect(identity.userData).not.toBe(path.join(identity.appData, 'AutoDoc'))
  } finally {
    await app.cleanup()
  }
})

test('packaged QA app exposes the simulator in real-app mode', async () => {
  test.skip(!packagedQAApp, 'Set AUTODOC_QA_PACKAGED_APP to the unpacked AutoDoc QA app.')
  const app = await launchPackagedRealSetupApp(packagedQAApp!)

  try {
    const identity = await app.electronApp.evaluate(({ app: electronApp }) => ({
      name: electronApp.getName(),
      version: electronApp.getVersion()
    }))
    expect(identity).toEqual({ name: 'AutoDoc QA', version: packageMetadata.version })

    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await page
      .getByTitle('Dismiss')
      .click({ timeout: 1_500 })
      .catch(() => {})
    await page.getByRole('link', { name: 'Settings' }).click()
    const simulator = page.getByRole('region', { name: 'Feedback prompt simulator' })
    await expect(simulator).toBeVisible()
    await expect(page.getByText('Updates disabled in QA builds')).toBeVisible()

    await simulator.getByRole('button', { name: 'Show first prompt' }).click()
    const prompt = page.getByRole('region', { name: 'How’s AutoDoc working for you?' })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Share feedback' })).toBeEnabled()
    await prompt.getByRole('button', { name: 'Don’t ask again' }).click()
    await expect(prompt).toHaveCount(0)

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(
      page
        .getByRole('region', { name: 'Feedback prompt simulator' })
        .getByText('Suppressed by Don’t ask again')
    ).toBeVisible()
  } finally {
    await app.cleanup()
  }
})
