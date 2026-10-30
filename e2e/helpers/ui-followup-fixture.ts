import type { ElectronApplication, Page } from '@playwright/test'
import { STAR_MEETING_ID, launchGithubStarApp } from './github-star'

/** Synthetic persisted meeting plus controlled UI outcomes; no inference or submissions. */
export async function launchUiFollowupApp() {
  const fixture = await launchGithubStarApp({ qualified: false })
  await fixture.electronApp.evaluate(({ ipcMain }, meetingId) => {
    const state = {
      title: 'Synthetic UI review',
      failureCode: '',
      videoProcessing: false,
      speakerName: 'Morgan',
      option: ''
    }
    ;(globalThis as any).__uiFollowup = state
    const handle = (channel: string, fn: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_e, ...args) => fn(...args))
    }
    handle('recording:get-detail', () => ({
      title: state.title,
      sourceName: 'Synthetic meeting',
      date: 1780000000000,
      durationSeconds: 600,
      videoStatus: state.videoProcessing ? 'processing' : undefined
    }))
    handle('recording:get-media', () => ({
      hasAudio: false,
      hasVideo: false,
      videoStatus: state.videoProcessing ? 'processing' : undefined
    }))
    handle('transcription:get-status', () => 'complete')
    handle('transcription:get-memory-failure', () => null)
    handle('segmentation:get-status', () =>
      state.failureCode === 'scan_or_persist' || !state.failureCode
        ? 'complete'
        : state.failureCode === 'no_notes_detected'
          ? 'no-notes'
          : 'failed'
    )
    handle('segmentation:get-error-code', () => state.failureCode || undefined)
    handle('segmentation:get-memory-failure', () => null)
    handle('notes:get-v2', () => null)
    handle('transcription:get-transcript', () => [
      {
        id: 'synthetic',
        meetingId,
        speaker: 'speaker_1',
        text: 'Synthetic transcript content.',
        startMs: 0,
        endMs: 10000,
        confidence: 1
      }
    ])
    handle('speakers:get', () => ({
      speaker_1: { label: state.speakerName, suggestions: ['Alex', 'Morgan'] }
    }))
    handle('recording:update-title', (_meetingId, title) => {
      state.title = title
    })
    handle('speakers:rename', (_meetingId, _speakerId, name) => {
      state.speakerName = name
    })
    ipcMain.removeHandler('chat:send-stream')
    ipcMain.handle('chat:send-stream', (event, requestId) => {
      queueMicrotask(() =>
        event.sender.send('chat:done', {
          requestId,
          content: 'Synthetic meeting choice.',
          clarificationOptions: [
            { meetingId, title: state.option, subtitle: state.option, notePreview: state.option }
          ]
        })
      )
    })
    handle('transcription:retry', () => undefined)
    handle('segmentation:retry', () => undefined)
    handle('recording:delete', () => undefined)
  }, STAR_MEETING_ID)
  return fixture
}

export async function setUiOutcome(
  app: ElectronApplication,
  next: { failureCode?: string; videoProcessing?: boolean; speakerName?: string; option?: string }
) {
  await app.evaluate((_e, next) => Object.assign((globalThis as any).__uiFollowup, next), next)
}

export async function openUiMeeting(page: Page) {
  await page.evaluate(() => {
    location.hash = '#/search'
  })
  await page.getByRole('textbox').waitFor()
  await page.evaluate((id) => {
    location.hash = `#/recordings/${id}`
  }, STAR_MEETING_ID)
}
