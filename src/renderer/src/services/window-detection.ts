import { MEETING_APP_PATTERNS } from '../../../shared/constants'
import type { RecordingSource } from '../../../shared/types'

export function detectMeetingWindow(sources: RecordingSource[]): RecordingSource | null {
  // Only check actual windows, not full-screen captures
  const windows = sources.filter((s) => !s.id.startsWith('screen:'))

  for (const { pattern } of MEETING_APP_PATTERNS) {
    const match = windows.find((s) => pattern.test(s.name))
    if (match) return match
  }

  return null
}
