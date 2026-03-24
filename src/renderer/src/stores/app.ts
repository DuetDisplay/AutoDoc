import { create } from 'zustand'

interface AppState {
  ollamaConnected: boolean
  isRecording: boolean
  recordingSeconds: number
  activePage: string

  setOllamaConnected: (connected: boolean) => void
  setRecording: (recording: boolean) => void
  setRecordingSeconds: (seconds: number) => void
  setActivePage: (page: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  ollamaConnected: false,
  isRecording: false,
  recordingSeconds: 0,
  activePage: '/',

  setOllamaConnected: (connected) => set({ ollamaConnected: connected }),
  setRecording: (recording) => set({ isRecording: recording }),
  setRecordingSeconds: (seconds) => set({ recordingSeconds: seconds }),
  setActivePage: (page) => set({ activePage: page }),
}))
