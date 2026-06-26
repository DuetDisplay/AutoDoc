import { ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { encryptJSON, decryptJSON, isEncrypted } from '../services/crypto'
import type { SpeakerMap } from '../../shared/types'

export function registerSpeakersIpc(recordingsBaseDir: string): void {
  ipcMain.handle('speakers:get', async (_event, meetingId: string): Promise<SpeakerMap> => {
    const speakersPath = join(recordingsBaseDir, meetingId, 'speakers.json')
    try {
      if (await isEncrypted(speakersPath)) {
        return await decryptJSON<SpeakerMap>(speakersPath)
      }
      return JSON.parse(await readFile(speakersPath, 'utf-8'))
    } catch {
      return {}
    }
  })

  ipcMain.handle(
    'speakers:rename',
    async (_event, meetingId: string, speakerId: string, newLabel: string): Promise<void> => {
      const speakersPath = join(recordingsBaseDir, meetingId, 'speakers.json')
      let speakers: SpeakerMap
      try {
        if (await isEncrypted(speakersPath)) {
          speakers = await decryptJSON<SpeakerMap>(speakersPath)
        } else {
          speakers = JSON.parse(await readFile(speakersPath, 'utf-8'))
        }
      } catch {
        speakers = {}
      }

      if (speakers[speakerId]) {
        speakers[speakerId].label = newLabel
      } else {
        speakers[speakerId] = { label: newLabel }
      }

      await encryptJSON(speakers, speakersPath)
    }
  )
}
