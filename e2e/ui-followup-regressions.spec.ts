import { test, expect } from '@playwright/test'
import { UI_LANGUAGE_CODES } from '../src/shared/ui-language'
import { translate } from '../src/shared/i18n'
import { notesFailureKindFromCode, notesUserCopy } from '../src/shared/notes-user-copy'
import {
  launchIsolatedE2EApp,
  launchIsolatedE2EAppWithEnv,
  completeOnboarding,
  installFakeCaptureDevices
} from './helpers/electron-app'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { launchUiFollowupApp, openUiMeeting, setUiOutcome } from './helpers/ui-followup-fixture'
import {
  setUi,
  setContentSize,
  settleLayout,
  contrastRatio,
  expectAnimationContrast,
  expectTextWithin,
  revealVertically,
  onboardingOcclusions
} from './helpers/ui-layout'

test('all notes-error variants use the selected language and fit at normal and high zoom', async () => {
  test.setTimeout(240000)
  const f = await launchUiFollowupApp()
  const { page, electronApp } = f
  try {
    for (const zoom of [1, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await setContentSize(electronApp, page, 788, 540, zoom)
          await setUi(page, language, theme)
          for (const code of [
            'no_notes_detected',
            'ollama-unavailable',
            'ollama-model-setup',
            'ollama-insufficient-memory',
            'writer-failed',
            'scan_or_persist'
          ]) {
            await setUiOutcome(electronApp, { failureCode: code })
            await openUiMeeting(page)
            // A legacy memory code without memory-failure measurements uses
            // the generic callout; measured memory failures have a separate UI.
            const expected = notesUserCopy(
              notesFailureKindFromCode(code === 'ollama-insufficient-memory' ? 'unknown' : code),
              language
            )
            const heading = page.getByRole('heading', { name: expected.title, exact: true })
            await expect(heading).toBeVisible()
            const card = heading.locator('..')
            await expect(card.getByText(expected.body, { exact: true })).toBeVisible()
            await expectTextWithin(card, page.locator('main'))
            for (const button of await card.getByRole('button').all()) {
              await revealVertically(button)
              await button.click({ trial: true })
              await expectTextWithin(button, page.locator('main'))
            }
            if (['ja', 'de', 'ko'].includes(language) && code === 'writer-failed')
              await page.screenshot({
                path: test.info().outputPath(`notes-${language}-${theme}-${zoom}.png`)
              })
          }
        }
  } finally {
    await f.cleanup()
  }
})

test('long speaker names, transcript labels and meeting choices stay inside the pane', async () => {
  test.setTimeout(180000)
  const f = await launchUiFollowupApp()
  const { page, electronApp } = f
  try {
    for (const zoom of [1, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await setContentSize(electronApp, page, 788, 540, zoom)
          await setUi(page, language, theme)
          const long =
            language === 'ja' || language === 'ko' || language === 'zh-Hans'
              ? '회의記録会议'.repeat(40)
              : 'SyntheticSpeakerNameWithoutSpaces'.repeat(5)
          await setUiOutcome(electronApp, { speakerName: long, option: long })
          await openUiMeeting(page)
          await page
            .getByRole('button', { name: translate(language, 'meeting.transcript'), exact: true })
            .click()
          for (const label of await page.getByText(long, { exact: true }).all())
            await expectTextWithin(label, page.locator('main'))
          const rename = page.getByRole('button', {
            name: translate(language, 'ui.rename'),
            exact: true
          })
          await revealVertically(rename)
          await rename.click({ trial: true })
          await page.evaluate(() => (location.hash = '#/ask-ai'))
          await page.getByRole('textbox').fill('Synthetic question')
          await page
            .getByRole('button', { name: translate(language, 'askAi.send'), exact: true })
            .click()
          const choice = page.getByRole('button', { name: new RegExp(long.slice(0, 12)) })
          await expect(choice).toBeVisible()
          await expectTextWithin(choice, page.locator('main'))
          await revealVertically(choice)
          await choice.click({ trial: true })
          if (['en', 'de', 'ko'].includes(language))
            await page.screenshot({
              path: test.info().outputPath(`choices-${language}-${theme}-${zoom}.png`)
            })
          await page
            .getByRole('button', { name: translate(language, 'askAi.newChat'), exact: true })
            .click()
        }
  } finally {
    await f.cleanup()
  }
})

test('Reprocess and Delete actions reflow inside the card at Windows minimum content size', async () => {
  test.setTimeout(180000)
  const f = await launchUiFollowupApp()
  const { page, electronApp } = f
  try {
    for (const zoom of [1, 1.25, 1.5, 2])
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await setContentSize(electronApp, page, 788, 540, zoom)
          await setUi(page, language, theme)
          await openUiMeeting(page)
          await page
            .getByRole('button', { name: translate(language, 'meeting.settings'), exact: true })
            .click()
          for (const action of await page
            .getByRole('button', { name: translate(language, 'meeting.reprocess'), exact: true })
            .all()) {
            await revealVertically(action)
            await action.click({ trial: true })
            await expectTextWithin(action, action.locator('..'))
            await expectTextWithin(action, page.locator('main'))
          }
          const del = page.getByRole('button', {
            name: translate(language, 'common.delete'),
            exact: true
          })
          await revealVertically(del)
          await del.click()
          const confirm = page.getByRole('button', {
            name: translate(language, 'meeting.confirmDelete'),
            exact: true
          })
          await revealVertically(confirm)
          await expectTextWithin(confirm, page.locator('main'))
          await confirm.click({ trial: true })
          await page
            .getByRole('button', { name: translate(language, 'common.cancel'), exact: true })
            .click()
          if (['el', 'uk'].includes(language))
            await page.screenshot({
              path: test.info().outputPath(`actions-${language}-${theme}-${zoom}.png`)
            })
        }
  } finally {
    await f.cleanup()
  }
})

test('hover, unfocused input and every processing-animation phase retain contrast', async () => {
  const f = await launchUiFollowupApp()
  const { page, electronApp } = f
  try {
    await setContentSize(electronApp, page, 1000, 720, 1)
    for (const theme of ['light', 'dark'] as const) {
      await setUi(page, 'en', theme)
      await setUiOutcome(electronApp, { videoProcessing: false })
      await openUiMeeting(page)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const del = page.getByRole('button', { name: 'Delete', exact: true })
      await del.hover()
      await del.evaluate(async (el) => {
        await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})))
      })
      expect(await contrastRatio(del)).toBeGreaterThanOrEqual(4.5)
      await setUiOutcome(electronApp, { videoProcessing: true })
      await openUiMeeting(page)
      await page.getByRole('button', { name: 'Transcript', exact: true }).click()
      const status = page.getByText(translate('en', 'ui.finishingUpYourVideo'), { exact: true })
      await expectAnimationContrast(status, `${theme} processing status`)
      await page.getByRole('button', { name: 'rename', exact: true }).click()
      await page.getByRole('button', { name: 'Alex', exact: true }).focus()
      const input = page.getByRole('textbox', {
        name: translate('en', 'ui.typeACustomName'),
        exact: true
      })
      expect(await contrastRatio(input, true)).toBeGreaterThanOrEqual(3)
      await page.screenshot({ path: test.info().outputPath(`input-${theme}.png`) })
      await page.keyboard.press('Escape')
      await electronApp.evaluate(({ ipcMain }) => {
        const entries = [
          'downloading',
          'diarizing',
          'notes-model',
          'notes-generating',
          'video',
          'transcribing',
          'notes-progress'
        ]
        const handle = (channel: string, fn: (...args: any[]) => unknown) => {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, (_e, ...args) => fn(...args))
        }
        handle('recording:list', () =>
          entries.map((id) => ({
            meetingId: id,
            title: 'Synthetic ' + id,
            date: 1780000000000,
            duration: 600,
            hasAudio: false,
            hasVideo: false,
            transcriptionStatus: ['downloading', 'diarizing', 'transcribing'].includes(id)
              ? id
              : 'complete',
            videoStatus: id === 'video' ? 'processing' : undefined
          }))
        )
        handle('transcription:get-progress', (id) => (id === 'transcribing' ? 100 : undefined))
        handle('transcription:get-status', (id) =>
          ['downloading', 'diarizing', 'transcribing'].includes(id) ? id : 'complete'
        )
        handle('whisper:get-setup-status', () => ({ phase: 'ready', percent: 100 }))
        handle('ollama:get-setup-status', () => ({ phase: 'ready', percent: 100 }))
        handle('segmentation:get-progress', (id) => (id === 'notes-progress' ? 100 : undefined))
        handle('segmentation:get-status', (id) =>
          id === 'notes-model'
            ? 'downloading-model'
            : id === 'notes-generating' || id === 'notes-progress'
              ? 'segmenting'
              : 'pending'
        )
      })
      await page.evaluate(() => (location.hash = '#/recordings'))
      for (const key of [
        'ui.downloadingModel',
        'ui.identifyingSpeakers',
        'ui.settingUpOllamaAndNotesModel',
        'meeting.preparingNotes',
        'recordings.processingVideo'
      ] as const) {
        const text = page.getByText(translate('en', key), { exact: true })
        await expect(text).toBeVisible()
        await revealVertically(text)
        await expectAnimationContrast(text, `${theme} ${key}`)
      }
      for (const key of ['ui.transcribingPercent', 'ui.shapingNotesPercent'] as const) {
        const text = page.getByText(translate('en', key, { percent: 100 }), { exact: true })
        await expect(text).toBeVisible()
        await revealVertically(text)
        const fill = await text
          .locator('..')
          .locator('.absolute')
          .evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(
          await contrastRatio(text, false, fill),
          `${theme} ${key} over progress fill`
        ).toBeGreaterThanOrEqual(4.5)
      }
      await page.evaluate(() => (location.hash = '#/settings'))
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      for (const state of ['checking', 'installing']) {
        await electronApp.evaluate(({ BrowserWindow }, state) => {
          BrowserWindow.getAllWindows()
            .find((w) => w.isFocusable())!
            .webContents.send('updater:status', { state, version: '1.3.2' })
        }, state)
        const text = page.getByText(
          translate('en', state === 'checking' ? 'settings.checking' : 'settings.restarting'),
          { exact: true }
        )
        await expect(text.first()).toBeVisible()
        for (const status of await text.all()) {
          if (await status.evaluate((el) => Boolean(el.closest(':disabled')))) continue
          await revealVertically(status)
          await expectAnimationContrast(status, `${theme} updater ${state}`)
        }
      }
    }
  } finally {
    await f.cleanup()
  }
})

test('the recording banner Stop action stays readable on hover and still stops capture', async () => {
  test.setTimeout(60000)
  const f = await launchIsolatedE2EAppWithEnv(
    {
      AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1',
      AUTODOC_E2E_FFMPEG_PATH: path.join(
        process.cwd(),
        'node_modules',
        'ffmpeg-static',
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
      )
    },
    { permissions: { microphone: true, screen: true } }
  )
  try {
    const page = await f.electronApp.firstWindow()
    await completeOnboarding(page)
    await installFakeCaptureDevices(page, { useRealMediaRecorder: true })
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    await page.getByRole('button').filter({ hasText: 'E2E Display' }).first().click()
    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeVisible()
    for (const theme of ['light', 'dark'] as const) {
      await setUi(page, 'en', theme)
      await stop.hover()
      await stop.evaluate((el) =>
        Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})))
      )
      const ratio = await contrastRatio(stop)
      writeFileSync(
        test.info().outputPath(`recording-stop-${theme}.json`),
        JSON.stringify({ theme, ratio })
      )
      expect(ratio, `${theme} recording banner Stop hover`).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: test.info().outputPath(`recording-stop-${theme}.png`) })
    }
    await stop.click()
    await expect(stop).toHaveCount(0)
    expect(
      await page.evaluate(
        async () => (await window.electronAPI.invoke('recording:get-state')).isRecording
      )
    ).toBe(false)
  } finally {
    await f.cleanup()
  }
})

test('title save/cancel and speaker selections preserve keyboard focus and normal Tab movement', async () => {
  const f = await launchUiFollowupApp()
  const { page } = f
  try {
    await openUiMeeting(page)
    const title = page.getByRole('button', { name: 'Synthetic UI review', exact: true })
    await title.focus()
    await page.keyboard.press('Enter')
    await page.locator('textarea').fill('Discard this draft')
    await page.keyboard.press('Escape')
    await expect(title).toBeFocused()
    await page.keyboard.press('Enter')
    const savedTitle = '工程計画 – 회의 검토'
    await page.locator('textarea').fill(savedTitle)
    await page.keyboard.press('Enter')
    const saved = page.getByRole('button', { name: savedTitle, exact: true })
    await expect(saved).toBeFocused()
    await page.reload()
    await expect(saved).toBeVisible()
    await saved.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await expect(saved).not.toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
    await page.getByRole('button', { name: 'Transcript', exact: true }).click()
    const rename = page.getByRole('button', { name: 'rename', exact: true })
    await rename.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(rename).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Escape')
    await expect(rename).toBeFocused()
  } finally {
    await f.cleanup()
  }
})

test('onboarding navigation never covers text while scrolling expanded content', async () => {
  test.setTimeout(240000)
  const f = await launchIsolatedE2EApp({ permissions: { microphone: true, screen: true } })
  const { electronApp } = f
  const page = await electronApp.firstWindow()
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ;(globalThis as any).__followupStep = 9
      ipcMain.removeHandler('prefs:get-onboarding-complete')
      ipcMain.handle('prefs:get-onboarding-complete', () => false)
      ipcMain.removeHandler('prefs:get-onboarding-step')
      ipcMain.handle('prefs:get-onboarding-step', () => (globalThis as any).__followupStep)
      ipcMain.removeHandler('prefs:get-onboarding-language-confirmed')
      ipcMain.handle('prefs:get-onboarding-language-confirmed', () => true)
    })
    for (const [step, zoom] of [
      [9, 1],
      [9, 2],
      [11, 2]
    ] as const)
      for (const theme of ['light', 'dark'] as const)
        for (const language of UI_LANGUAGE_CODES) {
          await setContentSize(electronApp, page, 788, 540, zoom)
          await setUi(page, language, theme)
          await electronApp.evaluate(
            (_e, step) => ((globalThis as any).__followupStep = step),
            step
          )
          await page.reload()
          await page.locator('h2').first().waitFor()
          await settleLayout(page)
          if (step === 9)
            await page
              .getByRole('button', {
                name: translate(language, 'ui.whatExactlyDoWeTrack'),
                exact: true
              })
              .click()
          const scroller = page.locator('h2').first()
          for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            await scroller.evaluate((el, fraction) => {
              for (let p = el.parentElement; p; p = p.parentElement)
                if (
                  /auto|scroll/.test(getComputedStyle(p).overflowY) &&
                  p.scrollHeight > p.clientHeight
                ) {
                  p.scrollTop = (p.scrollHeight - p.clientHeight) * fraction
                  break
                }
            }, fraction)
            await settleLayout(page)
            expect(
              await onboardingOcclusions(page, translate(language, 'ui.back')),
              `${language} ${theme} step ${step} zoom ${zoom} scroll ${fraction}`
            ).toEqual([])
          }
          const last = page.getByRole('button').last()
          await revealVertically(last)
          await last.click({ trial: true })
          if (['en', 'de', 'ko'].includes(language))
            await page.screenshot({
              path: test.info().outputPath(`onboarding-${step}-${language}-${theme}-${zoom}.png`)
            })
        }
  } finally {
    await f.cleanup()
  }
})
