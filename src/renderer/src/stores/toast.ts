import { create } from 'zustand'

interface Toast {
  type: 'screen' | 'microphone' | 'calendar'
  message: string
}

interface ToastStore {
  activeToast: Toast | null
  showToast: (toast: Toast) => void
  dismissToast: () => void
}

export const useToastStore = create<ToastStore>((set) => ({
  activeToast: null,

  showToast: (toast) => set({ activeToast: toast }),

  dismissToast: () => set({ activeToast: null }),
}))
