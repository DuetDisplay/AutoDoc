import { join } from 'path'
import { encryptJSON } from './crypto'
import { readMetadata } from './calendar-matcher'
import { showNotificationWindow } from '../notification-window'
import { focusMainWindow, getMainWindow } from './main-window'
import type { MeetingMetadata } from '../../shared/types'

function getMeetingDisplayTitle(metadata: MeetingMetadata | null): string | null {
  return metadata?.customTitle?.trim() || metadata?.calendarTitle?.trim() || metadata?.sourceName?.trim() || null
}

export function buildNotesReadyBody(displayTitle: string | null): string {
  if (!displayTitle) {
    return 'Your latest meeting is ready.'
  }

  return `Your transcript and notes for "${displayTitle}" are ready.`
}

export async function notifyNotesReady(
  recordingsBaseDir: string,
  meetingId: string
): Promise<boolean> {
  const meetingDir = join(recordingsBaseDir, meetingId)
  const metadata = await readMetadata(meetingDir)
  if (!metadata || metadata.notesReadyNotificationSentAt) {
    return false
  }

  const updatedMetadata: MeetingMetadata = {
    ...metadata,
    notesReadyNotificationSentAt: Date.now()
  }
  await encryptJSON(updatedMetadata, join(meetingDir, 'metadata.json'))

  showNotificationWindow({
    title: 'Notes Ready',
    body: buildNotesReadyBody(getMeetingDisplayTitle(updatedMetadata)),
    primaryActionLabel: 'Open Notes',
    onPrimaryAction: () => {
      focusMainWindow()
      getMainWindow()?.webContents.send('notes:open-meeting', { meetingId })
    },
    onDismiss: () => {}
  })

  return true
}
