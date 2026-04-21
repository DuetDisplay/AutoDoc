import { app } from 'electron'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RecordingState, RecordingPaths, RecordingTrackingContext } from '../../shared/types'
import { RECORDING_SUBDIR } from '../../shared/constants'

export class RecordingService {
  private state: RecordingState = {
    isRecording: false,
    meetingId: null,
    startedAt: null,
    sourceId: null,
    sourceName: null,
    trackedMeetingSourceId: null,
    trackedMeetingSourceName: null,
    trackedMeetingProviderId: null
  }

  getState(): RecordingState {
    return { ...this.state }
  }

  async startRecording(
    sourceId: string,
    sourceName: string,
    trackingContext: RecordingTrackingContext | null = null
  ): Promise<RecordingPaths> {
    if (this.state.isRecording) {
      throw new Error('Already recording')
    }

    const meetingId = randomUUID()
    const dir = this.getMeetingDir(meetingId)
    await mkdir(dir, { recursive: true })

    this.state = {
      isRecording: true,
      meetingId,
      startedAt: Date.now(),
      sourceId,
      sourceName,
      trackedMeetingSourceId: trackingContext?.meetingSourceId ?? null,
      trackedMeetingSourceName: trackingContext?.meetingSourceName ?? null,
      trackedMeetingProviderId: trackingContext?.providerId ?? null
    }

    return {
      meetingId,
      dir,
      video: join(dir, 'screen.webm'),
      audio: join(dir, 'audio.webm')
    }
  }

  stopRecording(): { meetingId: string; startedAt: number; sourceName: string | null } {
    if (!this.state.isRecording || !this.state.meetingId || !this.state.startedAt) {
      throw new Error('Not recording')
    }

    const { meetingId, startedAt, sourceName } = this.state

    this.state = {
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
      trackedMeetingSourceId: null,
      trackedMeetingSourceName: null,
      trackedMeetingProviderId: null
    }

    return { meetingId, startedAt, sourceName }
  }

  getRecordingsBaseDir(): string {
    return join(app.getPath('userData'), RECORDING_SUBDIR)
  }

  private getMeetingDir(meetingId: string): string {
    return join(this.getRecordingsBaseDir(), meetingId)
  }
}
