import { vi } from 'vitest'
import type {
  AppRuntimeInfo,
  CalendarAccount,
  CalendarEvent,
  MeetingSegments,
  RecordingEntry,
  Transcript,
} from '../../../shared/types'
import type { SearchResult, UpdateStatus } from '../../../preload/ipc.d'
import { useCalendarStore } from '../stores/calendar'
import { useChatStore } from '../stores/chat'
import { useRecordingStore } from '../stores/recording'
import { useSearchStore } from '../stores/search'
import { useToastStore } from '../stores/toast'

type InvokeHandler = unknown | ((...args: any[]) => unknown)

type Listener = (payload: any) => void

export interface MockElectronAPI {
  send: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emit: (channel: string, payload: any) => void
  setHandler: (channel: string, handler: InvokeHandler) => void
}

export function createElectronApiMock(handlers: Record<string, InvokeHandler> = {}): MockElectronAPI {
  const listenerMap = new Map<string, Set<Listener>>()

  const api: MockElectronAPI = {
    send: vi.fn(),
    invoke: vi.fn((channel: string, ...args: any[]) => {
      const handler = handlers[channel]
      const result = typeof handler === 'function' ? handler(...args) : handler
      return Promise.resolve(result)
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      const listeners = listenerMap.get(channel) ?? new Set<Listener>()
      listeners.add(listener)
      listenerMap.set(channel, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          listenerMap.delete(channel)
        }
      }
    }),
    emit: (channel: string, payload: any) => {
      const listeners = listenerMap.get(channel)
      if (!listeners) return
      for (const listener of listeners) {
        listener(payload)
      }
    },
    setHandler: (channel: string, handler: InvokeHandler) => {
      handlers[channel] = handler
    },
  }

  return api
}

export function installMockElectronApi(handlers: Record<string, InvokeHandler> = {}): MockElectronAPI {
  const api = createElectronApiMock(handlers)
  window.electronAPI = api as any
  return api
}

export function resetRendererStores(): void {
  useCalendarStore.setState({
    accounts: [],
    isConnecting: false,
    events: [],
    isSyncing: false,
  })
  useChatStore.setState({ messages: [] })
  useSearchStore.setState({ query: '', results: [], searched: false })
  useToastStore.setState({ activeToast: null })
  useRecordingStore.setState({
    isRecording: false,
    meetingId: null,
    startedAt: null,
    sourceId: null,
    sourceName: null,
    elapsedSeconds: 0,
    sources: [],
    isLoadingSources: false,
  })
}

export function createCalendarAccount(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: 'acct-google',
    provider: 'google',
    email: 'team@example.com',
    connectedAt: new Date('2026-04-16T09:00:00Z').getTime(),
    ...overrides,
  }
}

export function createCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    externalId: 'evt-ext-1',
    accountId: 'acct-google',
    provider: 'google',
    recurringEventId: null,
    title: 'Roadmap Sync',
    startTime: new Date('2026-04-16T14:00:00Z').getTime(),
    endTime: new Date('2026-04-16T14:30:00Z').getTime(),
    attendees: ['alice@example.com', 'bob@example.com'],
    meetingUrl: 'https://meet.google.com/road-map-sync',
    autoRecord: 'off',
    syncedAt: new Date('2026-04-16T13:55:00Z').getTime(),
    ...overrides,
  }
}

export function createRecordingEntry(overrides: Partial<RecordingEntry> = {}): RecordingEntry {
  return {
    meetingId: 'meeting-1',
    title: 'Roadmap Sync',
    date: new Date('2026-04-16T14:00:00Z').getTime(),
    duration: 1800,
    hasVideo: true,
    hasAudio: true,
    transcriptionStatus: 'complete',
    ...overrides,
  }
}

export function createTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: 't-1',
    meetingId: 'meeting-1',
    speaker: 'speaker-1',
    text: 'We should ship the transcript highlights this week.',
    startMs: 12_000,
    endMs: 18_000,
    confidence: 0.95,
    ...overrides,
  }
}

export function createMeetingSegments(overrides: Partial<MeetingSegments> = {}): MeetingSegments {
  return {
    decisions: [
      {
        id: 'seg-decision-1',
        meetingId: 'meeting-1',
        category: 'decision',
        topic: 'Launch',
        title: 'Ship transcript highlights',
        content: 'Launch transcript highlights to the beta cohort on Friday.',
        assignee: 'Chris',
        deadline: 'Friday',
        sourceStartMs: 12_000,
        sourceEndMs: 18_000,
      },
    ],
    actionItems: [],
    information: [
      {
        id: 'seg-info-1',
        meetingId: 'meeting-1',
        category: 'information',
        topic: 'Quality',
        title: 'Retention signal',
        content: 'Customers keep asking for transcript search and action items.',
        assignee: null,
        deadline: null,
        sourceStartMs: 20_000,
        sourceEndMs: 24_000,
      },
    ],
    discussion: [],
    statusUpdates: [],
    ...overrides,
  }
}

export function createSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    meetingId: 'meeting-1',
    title: 'Roadmap Sync',
    date: new Date('2026-04-16T14:00:00Z').getTime(),
    matches: [
      {
        type: 'transcript',
        text: 'We should ship the transcript highlights this week.',
      },
      {
        type: 'segment',
        category: 'decision',
        text: 'Ship transcript highlights: Launch transcript highlights to the beta cohort on Friday.',
      },
    ],
    ...overrides,
  }
}

export function createRuntimeInfo(overrides: Partial<AppRuntimeInfo> = {}): AppRuntimeInfo {
  return {
    platform: 'darwin',
    storagePath: '/tmp/autodoc-tests',
    whisperModel: 'ggml-base.en.bin',
    ollamaModel: 'llama3.2:3b',
    ...overrides,
  }
}

export function createUpdateStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: 'idle',
    ...overrides,
  }
}
