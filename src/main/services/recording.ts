import { app } from 'electron'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { RecordingState, RecordingPaths } from '../../shared/types'
import { RECORDING_DIR_NAME, RECORDING_SUBDIR } from '../../shared/constants'

export class RecordingService {
  private state: RecordingState = {
    isRecording: false,
    meetingId: null,
    startedAt: null,
    sourceId: null,
    sourceName: null,
  }

  getState(): RecordingState {
    return { ...this.state }
  }

  async startRecording(sourceId: string, sourceName: string): Promise<RecordingPaths> {
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
    }

    return {
      meetingId,
      dir,
      video: join(dir, 'screen.webm'),
      audio: join(dir, 'audio.webm'),
    }
  }

  stopRecording(): { meetingId: string; startedAt: number } {
    if (!this.state.isRecording || !this.state.meetingId || !this.state.startedAt) {
      throw new Error('Not recording')
    }

    const { meetingId, startedAt } = this.state

    this.state = {
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
    }

    return { meetingId, startedAt }
  }

  getRecordingsBaseDir(): string {
    return join(app.getPath('home'), RECORDING_DIR_NAME, RECORDING_SUBDIR)
  }

  private getMeetingDir(meetingId: string): string {
    return join(this.getRecordingsBaseDir(), meetingId)
  }
}
