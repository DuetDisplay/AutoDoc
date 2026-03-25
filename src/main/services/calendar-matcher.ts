import type { CalendarEvent, MeetingMetadata } from '../../shared/types'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { isEncrypted, decryptJSON } from './crypto'

/** Find calendar event that overlaps with the recording start time (±10min buffer) */
export function matchCalendarEvent(events: CalendarEvent[], recordingStartMs: number): CalendarEvent | null {
  const buffer = 10 * 60 * 1000
  let best: CalendarEvent | null = null
  let bestOverlap = 0
  for (const event of events) {
    const overlapStart = Math.max(event.startTime - buffer, recordingStartMs)
    const overlapEnd = Math.min(event.endTime + buffer, recordingStartMs + 1)
    if (overlapStart <= overlapEnd) {
      const closeness = Math.abs(event.startTime - recordingStartMs)
      if (!best || closeness < bestOverlap) {
        best = event
        bestOverlap = closeness
      }
    }
  }
  return best
}

export async function readMetadata(meetingDir: string): Promise<MeetingMetadata | null> {
  const metaPath = join(meetingDir, 'metadata.json')
  try {
    if (await isEncrypted(metaPath)) {
      return await decryptJSON<MeetingMetadata>(metaPath)
    }
    return JSON.parse(await readFile(metaPath, 'utf-8'))
  } catch {
    return null
  }
}
