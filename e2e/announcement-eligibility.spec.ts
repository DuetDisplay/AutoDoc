import { expect, test } from '@playwright/test'
import { launchGithubStarApp } from './helpers/github-star'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'

const UPGRADE_PROFILES = [
  { name: 'meeting language still pending', confirmed: false, dismissed: false, combined: true },
  {
    name: 'meeting language already confirmed',
    confirmed: true,
    dismissed: false,
    combined: false
  },
  {
    name: '1.3.0 announcement already dismissed',
    confirmed: false,
    dismissed: true,
    combined: false
  }
]

for (const profile of UPGRADE_PROFILES) {
  test(`upgrade announcement: ${profile.name}`, async () => {
    const fixture = await launchGithubStarApp({
      qualified: false,
      savedPreferences: {
        // Omit the new update flags to exercise the real upgrade initialization.
        uiAppearanceAnnouncementInitialized: undefined,
        uiAppearanceAnnouncementPending: undefined,
        onboardingLanguageConfirmed: profile.confirmed,
        meetingLanguageAnnouncementDismissed: profile.dismissed,
        meetingLanguage: 'en'
      }
    })
    try {
      const { page } = fixture
      const dialog = page.getByRole('dialog', { name: 'New', exact: true })
      await expect(dialog).toBeVisible()
      await expect(page.locator('dialog[open]')).toHaveCount(1)
      await expect(
        dialog.getByRole('heading', { name: 'Meeting language', exact: true })
      ).toHaveCount(profile.combined ? 1 : 0)
      await expect(dialog.getByRole('button', { name: 'App language', exact: true })).toBeVisible()
      if (profile.combined)
        await expect(
          dialog.getByRole('button', { name: 'Meeting language: English', exact: true })
        ).toBeEnabled()
      const variant = profile.combined ? 'combined' : 'app-appearance'
      await dialog.screenshot({
        animations: 'disabled',
        path: test.info().outputPath(`${variant}-light.png`)
      })
      await dialog.getByRole('switch', { name: 'Dark mode' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await dialog.screenshot({
        animations: 'disabled',
        path: test.info().outputPath(`${variant}-dark.png`)
      })
      await dialog.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      await page
        .locator('aside')
        .screenshot({ animations: 'disabled', path: test.info().outputPath('sidebar-dark.png') })
      await page.locator('aside').getByRole('switch').click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page
        .locator('aside')
        .screenshot({ animations: 'disabled', path: test.info().outputPath('sidebar-light.png') })
      await page.locator('aside .mt-auto').screenshot({
        animations: 'disabled',
        path: test.info().outputPath('sidebar-footer-light.png')
      })
      await fixture.restart()
      await expect(fixture.page.locator('dialog[open]')).toHaveCount(0)
      const pending = await fixture.page.evaluate(async () => ({
        meeting: await window.electronAPI.invoke('prefs:get-meeting-language-announcement-pending'),
        appearance: await window.electronAPI.invoke('prefs:get-ui-appearance-announcement-pending')
      }))
      expect(pending).toEqual({ meeting: false, appearance: false })
    } finally {
      await fixture.cleanup()
    }
  })
}

test('a user who dismissed both updates gets no popup after an app restart', async () => {
  const fixture = await launchGithubStarApp({
    qualified: false,
    savedPreferences: {
      onboardingLanguageConfirmed: false,
      meetingLanguageAnnouncementDismissed: true,
      uiAppearanceAnnouncementInitialized: true,
      uiAppearanceAnnouncementPending: false
    }
  })
  try {
    expect(
      await fixture.page.evaluate(async () => ({
        meeting: await window.electronAPI.invoke('prefs:get-meeting-language-announcement-pending'),
        appearance: await window.electronAPI.invoke('prefs:get-ui-appearance-announcement-pending')
      }))
    ).toEqual({ meeting: false, appearance: false })
    await expect(fixture.page.locator('dialog[open]')).toHaveCount(0)
  } finally {
    await fixture.cleanup()
  }
})

for (const combined of [true, false]) {
  test(`Later postpones until next launch (combined: ${combined})`, async () => {
    const fixture = await launchGithubStarApp({
      qualified: false,
      uiAppearanceAnnouncement: true,
      meetingLanguageAnnouncement: combined
    })
    try {
      const dialog = fixture.page.getByRole('dialog', { name: 'New', exact: true })
      await expect(dialog).toBeVisible()
      const later = dialog.getByRole('button', { name: 'Later', exact: true })
      const done = dialog.getByRole('button', { name: 'Done', exact: true })
      const laterBox = await later.boundingBox()
      const doneBox = await done.boundingBox()
      expect(laterBox!.x).toBeLessThan(doneBox!.x)
      await later.click()
      await expect(fixture.page.locator('dialog[open]')).toHaveCount(0)
      expect(
        await fixture.page.evaluate(() =>
          window.electronAPI.invoke('prefs:get-ui-appearance-announcement-pending')
        )
      ).toBe(true)
      await fixture.restart()
      const reopened = fixture.page.getByRole('dialog', { name: 'New', exact: true })
      await expect(reopened).toBeVisible()
      await expect(
        reopened.getByRole('region', { name: 'Meeting language', exact: true })
      ).toHaveCount(combined ? 1 : 0)
      await reopened.getByRole('button', { name: 'Done', exact: true }).click()
      await fixture.restart()
      await expect(fixture.page.locator('dialog[open]')).toHaveCount(0)
    } finally {
      await fixture.cleanup()
    }
  })
}

test('meeting language saves inline and Later only defers the remaining update', async () => {
  const fixture = await launchGithubStarApp({
    qualified: false,
    uiAppearanceAnnouncement: true,
    meetingLanguageAnnouncement: true
  })
  try {
    // Stub only speech preparation in this isolated profile to avoid downloading models.
    await fixture.electronApp.evaluate(
      ({ ipcMain }, languages) => {
        ;(globalThis as any).__announcementPreparedLanguages = []
        ipcMain.removeHandler('whisper:prepare-meeting-language')
        ipcMain.handle('whisper:prepare-meeting-language', (_event, language) => {
          ;(globalThis as any).__announcementPreparedLanguages.push(language)
        })
        ipcMain.removeHandler('whisper:get-meeting-language-states')
        ipcMain.handle('whisper:get-meeting-language-states', () =>
          Object.fromEntries(
            languages.map((language) => [
              language,
              { availability: 'available', reason: null, firstUseDownloadBytes: 0 }
            ])
          )
        )
      },
      [...UI_LANGUAGE_CODES]
    )
    const dialog = fixture.page.getByRole('dialog', { name: 'New', exact: true })
    await expect(dialog).toBeVisible()
    const meeting = dialog.getByRole('region', { name: 'Meeting language', exact: true })
    const picker = meeting.getByRole('button', { name: 'Meeting language: English', exact: true })
    await expect(picker).toBeEnabled()
    await picker.click()
    await fixture.page.getByRole('option', { name: /^German/ }).click()
    await expect(
      meeting.getByRole('button', { name: 'Meeting language: German', exact: true })
    ).toBeEnabled()
    expect(
      await fixture.electronApp.evaluate(() => (globalThis as any).__announcementPreparedLanguages)
    ).toEqual(['de'])
    expect(
      await fixture.page.evaluate(() => window.electronAPI.invoke('prefs:get-meeting-language'))
    ).toBe('de')
    expect(
      await fixture.page.evaluate(() => window.electronAPI.invoke('prefs:get-ui-language'))
    ).toBe('en')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Open Settings' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Later', exact: true }).click()
    await fixture.restart()
    const remaining = fixture.page.getByRole('dialog', { name: 'New', exact: true })
    await expect(remaining).toBeVisible()
    await expect(
      remaining.getByRole('region', { name: 'Meeting language', exact: true })
    ).toHaveCount(0)
    expect(
      await fixture.page.evaluate(() => window.electronAPI.invoke('prefs:get-meeting-language'))
    ).toBe('de')
    await remaining.getByRole('button', { name: 'Done', exact: true }).click()
  } finally {
    await fixture.cleanup()
  }
})
