import { create } from 'zustand'
import type { CalendarEvent, CalendarAccount } from '../../../shared/types'

interface CalendarState {
  accounts: CalendarAccount[]
  isConnecting: boolean
  events: CalendarEvent[]
  isSyncing: boolean

  setAccounts: (accounts: CalendarAccount[]) => void
  addAccount: (account: CalendarAccount) => void
  removeAccount: (accountId: string) => void
  setConnecting: (connecting: boolean) => void
  setEvents: (events: CalendarEvent[]) => void
  setSyncing: (syncing: boolean) => void
}

export const useCalendarStore = create<CalendarState>((set) => ({
  accounts: [],
  isConnecting: false,
  events: [],
  isSyncing: false,

  setAccounts: (accounts) => set({ accounts }),
  addAccount: (account) => set((state) => ({ accounts: [...state.accounts, account] })),
  removeAccount: (accountId) =>
    set((state) => ({
      accounts: state.accounts.filter((a) => a.id !== accountId)
    })),
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  setEvents: (events) => set({ events }),
  setSyncing: (syncing) => set({ isSyncing: syncing })
}))

// Derived selector — use in components: const isConnected = useCalendarStore(selectIsConnected)
export const selectIsConnected = (state: CalendarState) => state.accounts.length > 0
