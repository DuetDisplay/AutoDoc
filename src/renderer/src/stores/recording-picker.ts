import { create } from 'zustand'
import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from '../services/window-detection'

export type PickerDiagnosticTrigger = 'manual' | 'auto_record' | 'select_window'

interface RecordingPickerState {
  isOpen: boolean
  title: string
  subtitle: string | null
  sources: RecordingSource[]
  detectedId: string | null
  suggestionLabel: string | null
  selectionContext: RecordingSelectionContext | null
  trigger: 'manual' | 'auto_record'
  /** Diagnostics only: ids in score order, the opening request and where the picker came from. */
  scoredSourceIds: string[]
  requestId: number | null
  diagnosticTrigger: PickerDiagnosticTrigger
  openPicker: (params: {
    title: string
    subtitle?: string | null
    sources: RecordingSource[]
    detectedId?: string | null
    suggestionLabel?: string | null
    selectionContext?: RecordingSelectionContext | null
    trigger?: 'manual' | 'auto_record'
    scoredSourceIds?: string[]
    requestId?: number | null
    diagnosticTrigger?: PickerDiagnosticTrigger
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
  scoredSourceIds: [],
  requestId: null,
  diagnosticTrigger: 'manual',

  openPicker: ({
    title,
    subtitle = null,
    sources,
    detectedId = null,
    suggestionLabel = null,
    selectionContext = null,
    trigger = 'manual',
    scoredSourceIds = [],
    requestId = null,
    diagnosticTrigger = trigger
  }) =>
    set({
      isOpen: true,
      title,
      subtitle,
      sources,
      detectedId,
      suggestionLabel,
      selectionContext,
      trigger,
      scoredSourceIds,
      requestId,
      diagnosticTrigger
    }),

  closePicker: () =>
    set({
      isOpen: false,
      subtitle: null,
      sources: [],
      detectedId: null,
      suggestionLabel: null,
      selectionContext: null,
      trigger: 'manual',
      scoredSourceIds: [],
      requestId: null,
      diagnosticTrigger: 'manual'
    })
}))
