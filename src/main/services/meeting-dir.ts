import { stat } from 'fs/promises'

/** Only a confirmed ENOENT counts: other I/O errors must not read as a deleted recording. */
export async function isMeetingDirMissing(meetingDir: string): Promise<boolean> {
  try {
    await stat(meetingDir)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
}
