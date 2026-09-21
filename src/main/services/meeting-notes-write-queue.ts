import { resolve } from 'path'

const meetingWriteQueues = new Map<string, Promise<void>>()

export function createMeetingNotesWriteQueueKey(
  recordingsBaseDir: string,
  meetingId: string,
  platform = process.platform
): string {
  const key = `${resolve(recordingsBaseDir)}\u0000${meetingId}`
  return platform === 'darwin' || platform === 'win32' ? key.normalize('NFC').toLowerCase() : key
}

/** Serializes legacy and V2 note writes for one logical meeting. */
export function enqueueMeetingNotesWrite<T>(
  recordingsBaseDir: string,
  meetingId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = createMeetingNotesWriteQueueKey(recordingsBaseDir, meetingId)
  const previous = meetingWriteQueues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  meetingWriteQueues.set(key, tail)
  void tail.then(() => {
    if (meetingWriteQueues.get(key) === tail) meetingWriteQueues.delete(key)
  })
  return result
}
