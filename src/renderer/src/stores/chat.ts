import type { ChatCountSummary } from '../../../shared/types'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatClarificationOption, ChatSourceCard } from '../../../preload/ipc'

export interface MeetingChatScope {
  meetingId: string
  title: string
}

export interface Message {
  countSummary?: ChatCountSummary
  meetingScope?: MeetingChatScope
  id?: string
  role: 'user' | 'assistant'
  content: string
  status?: 'pending' | 'streaming' | 'complete' | 'failed' | 'canceled' | 'timed_out'
  originalQuestion?: string
  clarificationOptions?: ChatClarificationOption[]
  offerSearchAll?: boolean
  sources?: ChatSourceCard[]
  inventoryCount?: number
  scopedMeetingIds?: string[]
}

interface ChatState {
  messages: Message[]
  draftInput: string
  meetingScope: MeetingChatScope | null
  setMeetingScope: (scope: MeetingChatScope | null) => void
  startMeetingChat: (scope: MeetingChatScope) => void
  addMessage: (msg: Message) => void
  updateMessage: (
    id: string,
    content: string,
    clarificationOptions?: ChatClarificationOption[],
    status?: Message['status'],
    sources?: ChatSourceCard[],
    offerSearchAll?: boolean,
    inventoryCount?: number
  ) => void
  setMessageSources: (id: string, sources: ChatSourceCard[], inventoryCount?: number) => void
  setMessageCountSummary: (id: string, summary: ChatCountSummary) => void
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
      meetingScope: null,
      setMeetingScope: (meetingScope) => set({ meetingScope }),
      startMeetingChat: (meetingScope) => set({ messages: [], draftInput: '', meetingScope }),
      addMessage: (msg) => set((state) => ({ messages: capMessages([...state.messages, msg]) })),
      updateMessage: (
        id,
        content,
        clarificationOptions,
        status,
        sources,
        offerSearchAll,
        inventoryCount
      ) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id
                ? {
                    ...msg,
                    content,
                    clarificationOptions: clarificationOptions ?? msg.clarificationOptions,
                    sources: sources ?? msg.sources,
                    inventoryCount: inventoryCount ?? msg.inventoryCount,
                    offerSearchAll: offerSearchAll ?? msg.offerSearchAll,
                    status: status ?? msg.status
                  }
                : msg
            )
          )
        })),
      setMessageSources: (id, sources, inventoryCount) =>
        set((state) => ({
          messages: capMessages(
            state.messages.map((msg) =>
              msg.id === id
                ? { ...msg, sources, inventoryCount: inventoryCount ?? msg.inventoryCount }
                : msg
            )
          )
        })),
      setMessageCountSummary: (id, countSummary) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, countSummary } : message
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
      clearMessages: () => set({ messages: [], draftInput: '', meetingScope: null })
    }),
    {
      name: 'autodoc-ask-ai-chat',
      partialize: (state) => ({
        messages: state.messages
          .filter((message) => message.status !== 'pending' && message.status !== 'streaming')
          .slice(-MAX_CHAT_MESSAGES),
        draftInput: state.draftInput,
        meetingScope: state.meetingScope
      })
    }
  )
)
