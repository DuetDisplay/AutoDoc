import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatClarificationOption } from '../../../preload/ipc'

export interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
  originalQuestion?: string
  clarificationOptions?: ChatClarificationOption[]
}

interface ChatState {
  messages: Message[]
  addMessage: (msg: Message) => void
  updateMessage: (
    id: string,
    content: string,
    clarificationOptions?: ChatClarificationOption[]
  ) => void
  appendToMessage: (id: string, chunk: string) => void
  clearMessages: () => void
}

const MAX_CHAT_MESSAGES = 20
const capMessages = (messages: Message[]): Message[] => messages.slice(-MAX_CHAT_MESSAGES)

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      addMessage: (msg) => set((state) => ({ messages: capMessages([...state.messages, msg]) })),
      updateMessage: (id, content, clarificationOptions) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id
                ? {
                    ...msg,
                    content,
                    clarificationOptions: clarificationOptions ?? msg.clarificationOptions
                  }
                : msg
            )
          )
        })),
      appendToMessage: (id, chunk) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id ? { ...msg, content: msg.content + chunk } : msg
            )
          )
        })),
      clearMessages: () => set({ messages: [] })
    }),
    {
      name: 'autodoc-ask-ai-chat',
      partialize: (state) => ({ messages: state.messages.slice(-MAX_CHAT_MESSAGES) })
    }
  )
)
