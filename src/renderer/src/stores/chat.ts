import { create } from 'zustand'

export interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
}

interface ChatState {
  messages: Message[]
  addMessage: (msg: Message) => void
  updateMessage: (id: string, content: string) => void
  appendToMessage: (id: string, chunk: string) => void
  clearMessages: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  updateMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((msg) => (msg.id === id ? { ...msg, content } : msg))
    })),
  appendToMessage: (id, chunk) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, content: msg.content + chunk } : msg
      )
    })),
  clearMessages: () => set({ messages: [] })
}))
