import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatClarificationOption } from '../../../preload/ipc'

export interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'streaming' | 'complete' | 'failed' | 'canceled' | 'timed_out'
  originalQuestion?: string
  clarificationOptions?: ChatClarificationOption[]
}

interface ChatState {
  messages: Message[]
  draftInput: string
  addMessage: (msg: Message) => void
  updateMessage: (
    id: string,
    content: string,
    clarificationOptions?: ChatClarificationOption[],
    status?: Message['status']
  ) => void
  appendToMessage: (id: string, chunk: string) => void
  setMessageStatus: (id: string, status: Message['status']) => void
  removeEmptyInFlightAssistantMessages: () => void
  setDraftInput: (value: string) => void
  clearMessages: () => void
}

const MAX_CHAT_MESSAGES = 20
const capMessages = (messages: Message[]): Message[] => messages.slice(-MAX_CHAT_MESSAGES)

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      draftInput: '',
      addMessage: (msg) => set((state) => ({ messages: capMessages([...state.messages, msg]) })),
      updateMessage: (id, content, clarificationOptions, status) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id
                ? {
                    ...msg,
                    content,
                    clarificationOptions: clarificationOptions ?? msg.clarificationOptions,
                    status: status ?? msg.status
                  }
                : msg
            )
          )
        })),
      appendToMessage: (id, chunk) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id ? { ...msg, content: msg.content + chunk, status: 'streaming' } : msg
            )
          )
        })),
      setMessageStatus: (id, status) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) => (msg.id === id ? { ...msg, status } : msg))
          )
        })),
      removeEmptyInFlightAssistantMessages: () =>
        set((state) => ({
          messages: state.messages.filter(
            (msg) =>
              !(
                msg.role === 'assistant' &&
                msg.content.trim().length === 0 &&
                (msg.status === 'pending' ||
                  msg.status === 'streaming' ||
                  msg.status === 'canceled')
              )
          )
        })),
      setDraftInput: (value) => set({ draftInput: value }),
      clearMessages: () => set({ messages: [], draftInput: '' })
    }),
    {
      name: 'autodoc-ask-ai-chat',
      partialize: (state) => ({
        messages: state.messages
          .filter((message) => message.status !== 'pending' && message.status !== 'streaming')
          .slice(-MAX_CHAT_MESSAGES),
        draftInput: state.draftInput
      })
    }
  )
)
