import { buildMeetingProcessedProperties, type NotesOutcome } from '../../../shared/analytics-metrics'
import type { AppRuntimeInfo } from '../../../shared/types'
import { trackEvent } from './analytics'

export interface MeetingProcessTimes {
  recordingDurationSec?: number
  transcriptionDurationSec?: number
}

export function rememberTranscriptionComplete(
  store: Map<string, MeetingProcessTimes>,
  meetingId: string,
  recordingDurationSec: number | null | undefined,
  transcriptionDurationSec: number
): void {
  store.set(meetingId, {
    recordingDurationSec: recordingDurationSec ?? undefined,
    transcriptionDurationSec
  })
}

export function trackMeetingProcessed(input: {
  store: Map<string, MeetingProcessTimes>
  emitted: Set<string>
  meetingId: string
  runtimeInfo: AppRuntimeInfo | null
  notesOutcome: NotesOutcome
  notesDurationSec?: number
}): boolean {
  if (input.emitted.has(input.meetingId)) return false

  const times = input.store.get(input.meetingId)
  const properties = buildMeetingProcessedProperties({
    ramBucket: input.runtimeInfo?.ramBucket,
    cpuClass: input.runtimeInfo?.cpuClass,
    hasGpu: input.runtimeInfo?.hasGpu,
    recordingDurationSec: times?.recordingDurationSec,
    transcriptionDurationSec: times?.transcriptionDurationSec,
    notesOutcome: input.notesOutcome,
    notesDurationSec: input.notesDurationSec
  })
  if (!properties) return false

  input.emitted.add(input.meetingId)
  input.store.delete(input.meetingId)
  trackEvent('meeting_processed', properties)
  return true
}
