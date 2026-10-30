import { create } from 'zustand'
import type { MessageKey } from '../../../shared/i18n'
import type { RecordingSource } from '../../../shared/types'
import type { RecordingSelectionContext } from '../services/window-detection'

export type PickerDiagnosticTrigger = 'manual' | 'auto_record' | 'select_window'

interface RecordingPickerState {
  isOpen: boolean
  titleKey: MessageKey
  subtitleKey: MessageKey | null
  sources: RecordingSource[]
  detectedId: string | null
  suggestionLabelKey: MessageKey | null
  selectionContext: RecordingSelectionContext | null
  trigger: 'manual' | 'auto_record'
  /** Diagnostics only: ids in score order, the opening request and where the picker came from. */
  scoredSourceIds: string[]
  requestId: number | null
  diagnosticTrigger: PickerDiagnosticTrigger
  openPicker: (params: {
    titleKey: MessageKey
    subtitleKey?: MessageKey | null
    sources: RecordingSource[]
    detectedId?: string | null
    suggestionLabelKey?: MessageKey | null
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
  titleKey: 'recording.selectWindowToRecord',
  subtitleKey: null,
  sources: [],
  detectedId: null,
  suggestionLabelKey: null,
  selectionContext: null,
  trigger: 'manual',
  scoredSourceIds: [],
  requestId: null,
  diagnosticTrigger: 'manual',

  openPicker: ({
    titleKey,
    subtitleKey = null,
    sources,
    detectedId = null,
    suggestionLabelKey = null,
    selectionContext = null,
    trigger = 'manual',
    scoredSourceIds = [],
    requestId = null,
    diagnosticTrigger = trigger
  }) =>
    set({
      isOpen: true,
      titleKey,
      subtitleKey,
      sources,
      detectedId,
      suggestionLabelKey,
      selectionContext,
      trigger,
      scoredSourceIds,
      requestId,
      diagnosticTrigger
    }),

  closePicker: () =>
    set({
      isOpen: false,
      subtitleKey: null,
      sources: [],
      detectedId: null,
      suggestionLabelKey: null,
      selectionContext: null,
      trigger: 'manual',
      scoredSourceIds: [],
      requestId: null,
      diagnosticTrigger: 'manual'
    })
}))
