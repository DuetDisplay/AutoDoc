import { join } from 'path'
import { app } from 'electron'
import { encryptJSON } from './crypto'
import { readMetadata } from './calendar-matcher'
import { showNotificationWindow } from '../notification-window'
import { focusMainWindow, getMainWindow } from './main-window'
import type { MeetingMetadata } from '../../shared/types'

function getMeetingDisplayTitle(metadata: MeetingMetadata | null): string | null {
  return (
    metadata?.customTitle?.trim() ||
    metadata?.calendarTitle?.trim() ||
    metadata?.sourceName?.trim() ||
    null
  )
}

function truncateDisplayTitle(displayTitle: string, maxLength = 56): string {
  if (displayTitle.length <= maxLength) {
    return displayTitle
  }

  return `${displayTitle.slice(0, maxLength - 3).trimEnd()}...`
}

export function buildNotesReadyBody(displayTitle: string | null): string {
  if (!displayTitle) {
    return 'Notes are ready.'
  }

  return `${truncateDisplayTitle(displayTitle)} notes are ready.`
}

export async function notifyNotesReady(
  recordingsBaseDir: string,
  meetingId: string,
  options: { allowRepeat?: boolean } = {}
): Promise<boolean> {
  const meetingDir = join(recordingsBaseDir, meetingId)
  const metadata = await readMetadata(meetingDir)
  if (!metadata || (!options.allowRepeat && metadata.notesReadyNotificationSentAt)) {
    return false
  }
  const displayTitle = getMeetingDisplayTitle(metadata)
  const mainWindow = getMainWindow()
  const wasMainWindowVisible = mainWindow?.isVisible() ?? false
  const wasMainWindowMinimized = mainWindow?.isMinimized() ?? false
  const wasMainWindowFocused = mainWindow?.isFocused() ?? false
  if (mainWindow && wasMainWindowVisible && !wasMainWindowFocused && !wasMainWindowMinimized) {
    mainWindow.hide()
  }

  showNotificationWindow({
    title: 'Notes Ready',
    body: buildNotesReadyBody(displayTitle),
    ...(displayTitle
      ? { bodyTitle: truncateDisplayTitle(displayTitle), bodySuffix: 'notes are ready.' }
      : {}),
    primaryActionLabel: 'Open Notes',
    kind: 'notes-ready',
    onPrimaryAction: () => {
      focusMainWindow()
      getMainWindow()?.webContents.send('notes:open-meeting', { meetingId })
    },
    onDismiss: () => {
      const window = getMainWindow()
      if (!window) {
        if (!wasMainWindowFocused && process.platform === 'darwin') {
          app.hide()
        }
        return
      }
      if (!wasMainWindowFocused) {
        if (wasMainWindowMinimized) {
          window.minimize()
        } else {
          window.hide()
        }
      } else if (wasMainWindowMinimized) {
        window.minimize()
      } else if (!wasMainWindowVisible) {
        window.hide()
      }
      if (!wasMainWindowFocused && process.platform === 'darwin') {
        app.hide()
      }
    }
  })

  const updatedMetadata: MeetingMetadata = {
    ...metadata,
    notesReadyNotificationSentAt: Date.now()
  }
  await encryptJSON(updatedMetadata, join(meetingDir, 'metadata.json'))

  return true
}
