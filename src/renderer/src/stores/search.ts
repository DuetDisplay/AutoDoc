import { create } from 'zustand'
import type { SearchResult } from '../../../preload/ipc.d'

interface SearchStore {
  query: string
  results: SearchResult[]
  searched: boolean
  setQuery: (query: string) => void
  setResults: (results: SearchResult[], searched: boolean) => void
}

export const useSearchStore = create<SearchStore>((set) => ({
  query: '',
  results: [],
  searched: false,
  setQuery: (query) => set({ query, results: [], searched: false }),
  setResults: (results, searched) => set({ results, searched })
}))
