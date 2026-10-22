import { create } from 'zustand'
import type { MessageKey } from '../../../shared/i18n'

export interface ToastAction {
  label: string
  labelKey?: MessageKey
  type: 'open-settings' | 'navigate'
  target: 'screen' | 'microphone' | string
}

export interface Toast {
  type: 'screen' | 'microphone' | 'calendar' | 'warning'
  message: string
  messageKey?: MessageKey
  action?: ToastAction
}

interface ToastStore {
  activeToast: Toast | null
  showToast: (toast: Toast) => void
  dismissToast: () => void
}

export const useToastStore = create<ToastStore>((set) => ({
  activeToast: null,

  showToast: (toast) => set({ activeToast: toast }),

  dismissToast: () => set({ activeToast: null })
}))
