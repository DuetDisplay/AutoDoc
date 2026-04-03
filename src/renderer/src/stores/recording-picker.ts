import { create } from 'zustand'
import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from '../services/window-detection'

interface RecordingPickerState {
  isOpen: boolean
  title: string
  subtitle: string | null
  sources: RecordingSource[]
  detectedId: string | null
  selectionContext: RecordingSelectionContext | null
  openPicker: (params: {
    title: string
    subtitle?: string | null
    sources: RecordingSource[]
    detectedId?: string | null
    selectionContext?: RecordingSelectionContext | null
  }) => void
  closePicker: () => void
}

export const useRecordingPickerStore = create<RecordingPickerState>((set) => ({
  isOpen: false,
  title: 'Select a window to record',
  subtitle: null,
  sources: [],
  detectedId: null,
  selectionContext: null,

  openPicker: ({
    title,
    subtitle = null,
    sources,
    detectedId = null,
    selectionContext = null,
  }) =>
    set({
      isOpen: true,
      title,
      subtitle,
      sources,
      detectedId,
      selectionContext,
    }),

  closePicker: () =>
    set({
      isOpen: false,
      subtitle: null,
      sources: [],
      detectedId: null,
      selectionContext: null,
    }),
}))
