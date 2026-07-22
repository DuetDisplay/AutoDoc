/**
 * Windows headed repro:
 * pnpm run build; pnpm run test:e2e:headed -- e2e/greg-video-stall-repro.spec.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  completeOnboarding,
  installStableScreenshotBackground,
  relaunchIsolatedE2EApp
} from './helpers/electron-app'

const MEETING_ID = 'greg-video-stall-repro'
const MEETING_TITLE = 'Greg incident force repro'
const ARTIFACT_DIR = path.join(process.cwd(), 'artifacts', 'greg-repro')

function seedGregIncidentMeeting(userDataDir: string): void {
  const meetingDir = path.join(userDataDir, 'recordings', MEETING_ID)
  mkdirSync(meetingDir, { recursive: true })
  writeFileSync(
    path.join(meetingDir, 'metadata.json'),
    JSON.stringify({
      sourceName: 'Slack Huddle',
      customTitle: MEETING_TITLE,
      startedAt: Date.now() - 38 * 60_000,
      stoppedAt: Date.now() - 30_000,
      durationSeconds: 38 * 60,
      isFinalizing: true
    })
  )
  writeFileSync(path.join(meetingDir, 'screen-0000.webm'), Buffer.from('segment-one'))
  writeFileSync(path.join(meetingDir, 'screen-0001.webm'), Buffer.from('segment-two'))
  writeFileSync(
    path.join(meetingDir, 'transcript.json'),
    JSON.stringify([
      {
        id: `${MEETING_ID}-transcript-1`,
        meetingId: MEETING_ID,
        speaker: 'Greg',
        text: 'The transcript remains available after video post-processing fails.',
        startMs: 0,
        endMs: 4_000,
        confidence: 0.99
      }
    ])
  )
  writeFileSync(
    path.join(meetingDir, 'segments.json'),
    JSON.stringify({
      decisions: [],
      actionItems: [],
      information: [
        {
          id: `${MEETING_ID}-note-1`,
          meetingId: MEETING_ID,
          category: 'information',
          topic: 'Recovery',
          title: 'Transcript remains openable',
          content: 'Video failure no longer leaves the meeting permanently finalizing.',
          assignee: null,
          deadline: null,
          sourceStartMs: 0,
          sourceEndMs: 4_000
        }
      ],
      discussion: [],
      statusUpdates: []
    })
  )
}

test('Greg video concat stall clears finalizing and leaves transcript openable', async () => {
  test.setTimeout(90_000)
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autodoc-greg-repro-'))
  seedGregIncidentMeeting(userDataDir)

  const app = await relaunchIsolatedE2EApp(
    userDataDir,
    {
      platform: 'win32',
      permissions: { microphone: true, screen: true }
    },
    {
      AUTODOC_E2E_FFMPEG_PATH: 'e2e-forced-ffmpeg',
      AUTODOC_E2E_FFMPEG_STALL_LABEL: 'video concat',
      AUTODOC_E2E_FFMPEG_STALL_TIMEOUT_MS: '1500',
      AUTODOC_E2E_SKIP_LOCAL_PROCESSING: '1'
    }
  )

  try {
    const page = await app.electronApp.firstWindow()
    await completeOnboarding(page)
    await installStableScreenshotBackground(page)
    await page.getByRole('link', { name: 'AI Notes' }).click()

    await expect(page.getByText(MEETING_TITLE)).toBeVisible()
    await expect(page.getByText('Wrapping up recording...')).toBeVisible()
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '01-greg-wrapping-up.png'),
      fullPage: true
    })

    await page.evaluate(async (meetingId) => {
      await window.electronAPI.invoke('recording:finalize-stop', meetingId)
    }, MEETING_ID)

    await expect(page.getByText('Wrapping up recording...')).toBeHidden({ timeout: 10_000 })
    await expect(page.getByText(MEETING_TITLE)).toBeVisible()

    await expect
      .poll(
        async () => {
          const detail = await page.evaluate(async (meetingId) => {
            return await window.electronAPI.invoke('recording:get-detail', meetingId)
          }, MEETING_ID)
          return detail
        },
        { timeout: 15_000 }
      )
      .toMatchObject({
        isFinalizing: false,
        videoStatus: 'failed',
        videoProcessingFailed: true
      })

    await expect(page.getByText('Video failed')).toBeVisible({ timeout: 5_000 })
    await page.reload()
    await installStableScreenshotBackground(page)
    await expect(page.getByText(MEETING_TITLE)).toBeVisible()
    await expect(page.getByText('Wrapping up recording...')).toBeHidden()
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '02-greg-finalizing-cleared.png'),
      fullPage: true
    })

    await page.getByText(MEETING_TITLE).click()
    await expect(
      page.getByText('Wrapping up this recording. It should finish appearing in a moment.')
    ).toBeHidden()
    await page.getByRole('button', { name: 'Transcript' }).click()
    await expect(
      page.getByText('The transcript remains available after video post-processing fails.')
    ).toBeVisible()
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, '03-greg-transcript-openable.png'),
      fullPage: true
    })

    console.log(`Greg repro screenshots: ${ARTIFACT_DIR}`)
  } finally {
    await app.cleanup()
  }
})
