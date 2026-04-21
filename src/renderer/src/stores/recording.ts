import { create } from 'zustand'
import type { RecordingState, RecordingSource } from '../../../shared/types'

interface RecordingStore extends RecordingState {
  elapsedSeconds: number
  sources: RecordingSource[]
  isLoadingSources: boolean

  setRecordingState: (state: RecordingState) => void
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
  trackedMeetingSourceId: null,
  trackedMeetingSourceName: null,
  trackedMeetingProviderId: null,
  elapsedSeconds: 0,
  sources: [],
  isLoadingSources: false,

  setRecordingState: (state) =>
    set({
      ...state,
      elapsedSeconds: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0
    }),

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
      trackedMeetingSourceId: null,
      trackedMeetingSourceName: null,
      trackedMeetingProviderId: null,
      elapsedSeconds: 0
    })
}))
