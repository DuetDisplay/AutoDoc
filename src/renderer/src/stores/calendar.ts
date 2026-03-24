import { create } from 'zustand'
import type { CalendarEvent } from '../../../shared/types'

interface CalendarState {
  isConnected: boolean
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  setConnected: (connected: boolean) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
  toggleAutoRecord: (eventId: string) => void
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
  toggleAutoRecord: (eventId) =>
    set((state) => ({
      events: state.events.map((e) =>
        e.id === eventId ? { ...e, autoRecord: !e.autoRecord } : e
      ),
    })),
}))
