import { create } from 'zustand'
import type { RecordingSource } from '../../../shared/types'

interface RecordingPickerState {
  isOpen: boolean
  title: string
  subtitle: string | null
  sources: RecordingSource[]
  detectedId: string | null
  openPicker: (params: {
    title: string
    subtitle?: string | null
    sources: RecordingSource[]
    detectedId?: string | null
  }) => void
  closePicker: () => void
}

export const useRecordingPickerStore = create<RecordingPickerState>((set) => ({
  isOpen: false,
  title: 'Select a window to record',
  subtitle: null,
  sources: [],
  detectedId: null,

  openPicker: ({ title, subtitle = null, sources, detectedId = null }) =>
    set({
      isOpen: true,
      title,
      subtitle,
      sources,
      detectedId,
    }),

  closePicker: () =>
    set({
      isOpen: false,
      subtitle: null,
      sources: [],
      detectedId: null,
    }),
}))
