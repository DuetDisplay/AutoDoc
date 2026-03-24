import { create } from 'zustand'

interface AppState {
  ollamaConnected: boolean
  activePage: string

  setOllamaConnected: (connected: boolean) => void
  setActivePage: (page: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  ollamaConnected: false,
  activePage: '/',

  setOllamaConnected: (connected) => set({ ollamaConnected: connected }),
  setActivePage: (page) => set({ activePage: page }),
}))
