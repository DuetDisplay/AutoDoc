import { create } from 'zustand'
import type { RecordingState, RecordingSource } from '../../../shared/types'

interface RecordingStore extends RecordingState {
  elapsedSeconds: number
  videoDisabled: boolean
  sources: RecordingSource[]
  isLoadingSources: boolean

  setRecordingState: (state: RecordingState) => void
  setVideoDisabled: (disabled: boolean) => void
  tick: () => void
  setSources: (sources: RecordingSource[]) => void
  setLoadingSources: (loading: boolean) => void
  reset: () => void
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  isRecording: false,
  meetingId: null,
  startedAt: null,
  sourceId: null,
  sourceName: null,
  recordingIntent: null,
  trackedMeetingSourceId: null,
  trackedMeetingSourceName: null,
  trackedMeetingProviderId: null,
  elapsedSeconds: 0,
  videoDisabled: false,
  sources: [],
  isLoadingSources: false,

  setRecordingState: (state) =>
    set((current) => ({
      ...state,
      elapsedSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
      videoDisabled:
        state.isRecording && current.isRecording && state.meetingId === current.meetingId
          ? current.videoDisabled
          : false
    })),

  setVideoDisabled: (disabled) => set({ videoDisabled: disabled }),

  tick: () =>
    set((s) => ({
      elapsedSeconds: s.startedAt
        ? Math.floor((Date.now() - s.startedAt) / 1000)
        : s.elapsedSeconds + 1
    })),

  setSources: (sources) => set({ sources }),
  setLoadingSources: (loading) => set({ isLoadingSources: loading }),

  reset: () =>
    set({
      isRecording: false,
      meetingId: null,
      startedAt: null,
      sourceId: null,
      sourceName: null,
      recordingIntent: null,
      trackedMeetingSourceId: null,
      trackedMeetingSourceName: null,
      trackedMeetingProviderId: null,
      elapsedSeconds: 0,
      videoDisabled: false
    })
}))
