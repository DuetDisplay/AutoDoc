import { create } from 'zustand'
import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from '../services/window-detection'

interface RecordingPickerState {
  isOpen: boolean
  title: string
  subtitle: string | null
  sources: RecordingSource[]
  detectedId: string | null
  suggestionLabel: string | null
  selectionContext: RecordingSelectionContext | null
  trigger: 'manual' | 'auto_record'
  openPicker: (params: {
    title: string
    subtitle?: string | null
    sources: RecordingSource[]
    detectedId?: string | null
    suggestionLabel?: string | null
    selectionContext?: RecordingSelectionContext | null
    trigger?: 'manual' | 'auto_record'
  }) => void
  closePicker: () => void
}

export const useRecordingPickerStore = create<RecordingPickerState>((set) => ({
  isOpen: false,
  title: 'Select a window to record',
  subtitle: null,
  sources: [],
  detectedId: null,
  suggestionLabel: null,
  selectionContext: null,
  trigger: 'manual',

  openPicker: ({
    title,
    subtitle = null,
    sources,
    detectedId = null,
    suggestionLabel = null,
    selectionContext = null,
    trigger = 'manual'
  }) =>
    set({
      isOpen: true,
      title,
      subtitle,
      sources,
      detectedId,
      suggestionLabel,
      selectionContext,
      trigger
    }),

  closePicker: () =>
    set({
      isOpen: false,
      subtitle: null,
      sources: [],
      detectedId: null,
      suggestionLabel: null,
      selectionContext: null,
      trigger: 'manual'
    })
}))
