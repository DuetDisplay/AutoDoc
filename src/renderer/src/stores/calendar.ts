import { create } from 'zustand'
import type { AutoRecordMode, CalendarEvent } from '../../../shared/types'

interface CalendarState {
  isConnected: boolean
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
  setAutoRecord: (eventId: string, mode: AutoRecordMode) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  isConnected: false,
  isConnecting: false,
  events: [],
  isSyncing: false,

  setConnected: (connected) => set({ isConnected: connected }),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setEvents: (events) => set({ events }),
  setSyncing: (syncing) => set({ isSyncing: syncing }),
  setAutoRecord: (eventId, mode) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.id === eventId ? { ...e, autoRecord: mode } : e
      ),
    })),
}))
