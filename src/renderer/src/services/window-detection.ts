import { MEETING_APP_PATTERNS, BROWSER_PATTERNS } from '../../../shared/constants'
import type { RecordingSource } from '../../../shared/types'

export function detectMeetingWindow(sources: RecordingSource[]): RecordingSource | null {
  // Only check actual windows, not full-screen captures
  const windows = sources.filter((s) => !s.id.startsWith('screen:'))

  // First: try matching known meeting app patterns
  for (const { pattern } of MEETING_APP_PATTERNS) {
    const match = windows.find((s) => pattern.test(s.name))
    if (match) return match
  }

  // Fallback: if mic is active but no meeting pattern matched,
  // the meeting is likely in a browser — pick the first browser window
  for (const pattern of BROWSER_PATTERNS) {
    const match = windows.find((s) => pattern.test(s.name))
    if (match) return match
  }

  return null
}
