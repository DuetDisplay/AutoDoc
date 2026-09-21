import { app, ipcMain, type WebContents } from 'electron'
import Store from 'electron-store'
import { NotesFeedbackService, type FeedbackReceipt } from '../services/notes-feedback'
import { NotesRepository } from '../services/notes-repository'
import { getKey, initializeEncryption } from '../services/crypto'

export function registerNotesFeedbackIpc(options: {
  recordingsBaseDir: string
  isTrustedSender: (sender: WebContents) => boolean
  analyticsEnabled: () => boolean
}): void {
  const repository = new NotesRepository(options.recordingsBaseDir)
  let service: NotesFeedbackService | undefined
  async function getService(): Promise<NotesFeedbackService> {
    // Do not create a key at IPC registration: startup must first check existing encrypted recordings.
    await initializeEncryption(options.recordingsBaseDir)
    if (!service) {
      // Pending explicit submissions contain user-entered text; keep them encrypted locally.
      const store = new Store<Record<string, FeedbackReceipt>>({
        name: 'notes-feedback-receipts',
        accessPropertiesByDotNotation: false,
        encryptionKey: getKey()
      })
      service = new NotesFeedbackService({
        readNotes: (meetingId) => repository.readV2(meetingId),
        receipts: {
          get: (key) => store.get(key),
          set: (key, value) => {
            store.set(key, value)
          }
        },
        projectKey: process.env.VITE_POSTHOG_KEY ?? '',
        host: process.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        appVersion: app.getVersion(),
        platform: process.platform,
        analyticsEnabled: options.analyticsEnabled
      })
    }
    return service
  }
  ipcMain.handle(
    'notes-feedback:state',
    async (event, meetingId: unknown, generationId: unknown) => {
      if (!options.isTrustedSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
        return { available: false, sent: false, analyticsEnabled: false }
      }
      try {
        return await (await getService()).state(meetingId, generationId)
      } catch {
        return { available: false, sent: false, analyticsEnabled: options.analyticsEnabled() }
      }
    }
  )
  ipcMain.handle('notes-feedback:send', async (event, request: unknown) => {
    if (!options.isTrustedSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      return { status: 'failed', code: 'invalid-request' }
    }
    try {
      return await (await getService()).submit(request)
    } catch {
      return { status: 'failed', code: 'unavailable' }
    }
  })
}
