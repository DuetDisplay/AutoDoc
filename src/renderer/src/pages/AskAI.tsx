import { translatePlural } from '../../../shared/i18n'
import { askAiCountFilterCopy } from '../services/ask-ai-count-copy'
import {
  useCallback,
  useState,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import { renderNoteMarkup } from '../components/NoteMarkup'
import { AskAiIndexNotice } from '../components/AskAiIndexNotice'
import { PageHeader } from '../components/PageHeader'
import { BetaBadge } from '../components/BetaBadge'
import { AskAiBetaNotice } from '../components/AskAiBetaNotice'
import { useChatStore, type MeetingChatScope, type Message } from '../stores/chat'
import { trackEvent } from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import type { ChatClarificationOption, ChatSourceCard } from '../../../preload/ipc'
import { useI18n } from '../services/i18n'

let fallbackRequestIdCounter = 0
const FIRST_TOKEN_TIMEOUT_MS = 45_000
const COMPLETION_TIMEOUT_MS = 180_000

function createChatRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return randomId

  fallbackRequestIdCounter += 1
  return `chat-${fallbackRequestIdCounter}`
}

function formatSourceTime(startMs: number | null): string | null {
  if (startMs == null || !Number.isFinite(startMs) || startMs < 0) return null
  const seconds = Math.floor(startMs / 1000)
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** One link per recording and displayed timestamp; the first passage keeps its number (AD-202). */
function sourceLinks(sources: ChatSourceCard[]): ChatSourceCard[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = `${source.meetingId}\u0000${formatSourceTime(source.startMs) ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function openSource(source: ChatSourceCard): void {
  const params = new URLSearchParams()
  if (source.startMs != null) params.set('t', String(Math.floor(source.startMs)))
  const query = params.toString()
  window.location.hash = `#/recordings/${encodeURIComponent(source.meetingId)}${query ? `?${query}` : ''}`
}

function displayAnswer(message: Message): string {
  // [0] is the writer's no-evidence marker (AD-202); the final answer arrives without it.
  const content = message.content.replace(/\[(?:n|0)\]/g, '')
  // Hold a possible literal placeholder until its next chunk resolves it.
  return message.status === 'pending' || message.status === 'streaming'
    ? content.replace(/\[(?:n|0)?$/, '')
    : content
}

export function AskAI(): ReactElement {
  const { t, language } = useI18n()
  const {
    messages,
    draftInput,
    meetingScope,
    setMeetingScope,
    addMessage,
    updateMessage,
    appendToMessage,
    setMessageStatus,
    removeEmptyInFlightAssistantMessages,
    setDraftInput,
    setMessageSources,
    setMessageCountSummary,
    clearMessages
  } = useChatStore()
  useEffect(() => {
    if (
      !messages.some(
        (message) =>
          message.id &&
          message.sources?.length &&
          message.inventoryCount === undefined &&
          !message.meetingScope &&
          !message.scopedMeetingIds?.length
      )
    )
      return
    let active = true
    void window.electronAPI
      .invoke('chat:inventory-count')
      .then((count) => {
        if (!active || !Number.isInteger(count) || count < 0) return
        for (const message of useChatStore.getState().messages)
          if (message.id && message.sources?.length && message.inventoryCount === undefined)
            setMessageSources(message.id, message.sources, count)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [messages, setMessageSources])
  const [loading, setLoading] = useState(false)
  const [notesWork, setNotesWork] = useState<Array<{ meetingId: string; title: string }>>([])
  const activitySentAtRef = useRef(-10_000)
  const lastTypedAtRef = useRef(0)
  const typingTimerRef = useRef<number | null>(null)
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeStreamCleanupRef = useRef<(() => void) | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const activeAssistantMessageIdRef = useRef<string | null>(null)
  const firstTokenTimeoutRef = useRef<number | null>(null)
  const completionTimeoutRef = useRef<number | null>(null)
  const isSendingRef = useRef(false)
  const mountedRef = useRef(false)
  const healthCheckVersionRef = useRef(0)

  const clearRequestTimeouts = useCallback((): void => {
    if (firstTokenTimeoutRef.current) {
      window.clearTimeout(firstTokenTimeoutRef.current)
      firstTokenTimeoutRef.current = null
    }
    if (completionTimeoutRef.current) {
      window.clearTimeout(completionTimeoutRef.current)
      completionTimeoutRef.current = null
    }
  }, [])

  const refreshOllamaReady = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return
    const version = ++healthCheckVersionRef.current
    let ready = false
    try {
      ready = await window.electronAPI.invoke('ollama:check-status')
    } catch {
      // A failed health IPC check can recover on the next event or poll.
    }
    if (mountedRef.current && version === healthCheckVersionRef.current) setOllamaReady(ready)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refreshOllamaReady()
    void window.electronAPI.invoke('chat:warmup').then(refreshOllamaReady, refreshOllamaReady)
    const unsubscribe = window.electronAPI.on('ollama:setup-progress', () => {
      void refreshOllamaReady()
    })
    const interval = window.setInterval(() => void refreshOllamaReady(), 5000)
    const onFocus = (): void => {
      void refreshOllamaReady()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      mountedRef.current = false
      healthCheckVersionRef.current++
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [refreshOllamaReady])

  useEffect(() => {
    let active = true
    let version = 0
    const refresh = async (): Promise<void> => {
      const current = ++version
      try {
        const work = await window.electronAPI.invoke('chat:notes-work')
        if (active && current === version) setNotesWork(work ?? [])
      } catch {
        // A later queue event or poll refreshes transient filesystem failures.
      }
    }
    void refresh()
    const unsubscribe = window.electronAPI.on('segmentation:status-changed', () => void refresh())
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [])

  const reportTyping = (): void => {
    const now = Date.now()
    lastTypedAtRef.current = now
    const report = (): void => {
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
      activitySentAtRef.current = Date.now()
      void window.electronAPI.invoke('chat:activity', lastTypedAtRef.current)
    }
    const remaining = 10_000 - (now - activitySentAtRef.current)
    if (remaining <= 0) report()
    else if (typingTimerRef.current === null)
      typingTimerRef.current = window.setTimeout(report, remaining)
  }

  useEffect(() => {
    return () => {
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current)
      void window.electronAPI.invoke('chat:close')
      const activeRequestId = activeRequestIdRef.current
      if (activeRequestId) {
        void window.electronAPI.invoke('chat:cancel', activeRequestId)
        trackEvent('chat_response_failed', { failure_code: 'left_page' })
      }
      activeStreamCleanupRef.current?.()
      clearRequestTimeouts()
      const activeAssistantMessageId = activeAssistantMessageIdRef.current
      if (activeAssistantMessageId) {
        setMessageStatus(activeAssistantMessageId, 'canceled')
      }
      removeEmptyInFlightAssistantMessages()
      activeRequestIdRef.current = null
      activeAssistantMessageIdRef.current = null
      isSendingRef.current = false
    }
  }, [clearRequestTimeouts, removeEmptyInFlightAssistantMessages, setMessageStatus])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const finishActiveRequest = (): void => {
    clearRequestTimeouts()
    isSendingRef.current = false
    setLoading(false)
    activeRequestIdRef.current = null
    activeAssistantMessageIdRef.current = null
    activeStreamCleanupRef.current?.()
    activeStreamCleanupRef.current = null
    inputRef.current?.focus()
    void refreshOllamaReady()
  }

  const markActiveRequestTimedOut = (requestId: string, messageId: string): void => {
    if (activeRequestIdRef.current !== requestId) return
    updateMessage(messageId, t('askAi.timeout'), undefined, 'timed_out')
    void window.electronAPI.invoke('chat:cancel', requestId)
    trackEvent('chat_response_failed', { failure_code: 'timed_out' })
    finishActiveRequest()
  }

  const sendChatRequest = async (params: {
    question: string
    displayQuestion: string
    selectedMeetingId?: string
    scopeOverride?: MeetingChatScope | null
    historyOverride?: Message[]
    searchAll?: boolean
  }): Promise<void> => {
    const question = params.question.trim()
    if (!question || loading || isSendingRef.current || activeRequestIdRef.current) return
    isSendingRef.current = true
    activeStreamCleanupRef.current?.()
    clearRequestTimeouts()
    const requestId = createChatRequestId()
    const assistantMessageId = `assistant-${requestId}`
    activeRequestIdRef.current = requestId
    activeAssistantMessageIdRef.current = assistantMessageId
    const scope = params.scopeOverride === undefined ? meetingScope : params.scopeOverride
    const history = (params.historyOverride ?? messages)
      .filter(
        (message) =>
          message.content.trim().length > 0 &&
          message.status !== 'timed_out' &&
          message.status !== 'failed'
      )
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content:
          message.content +
          (message.countSummary
            ? `\nNative saved-recording count: ${message.countSummary.count}. Filter used: ${message.countSummary.filterDescription}.`
            : '')
      }))
    addMessage({ role: 'user', content: params.displayQuestion })
    addMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      status: 'pending',
      originalQuestion: question,
      ...(scope ? { meetingScope: scope } : {}),
      ...(params.selectedMeetingId ? { scopedMeetingIds: [params.selectedMeetingId] } : {})
    })
    setLoading(true)
    recordDiagnosticAction({
      category: 'chat',
      action: 'chat_message_sent',
      details: {
        questionLength: question.length
      }
    })
    trackEvent('chat_message_sent', {
      selected_recording: Boolean(params.selectedMeetingId)
    })

    const cleanupListeners = [
      window.electronAPI.on('chat:count-result', (payload) => {
        if (payload.requestId !== requestId || activeRequestIdRef.current !== requestId) return
        if (firstTokenTimeoutRef.current) {
          window.clearTimeout(firstTokenTimeoutRef.current)
          firstTokenTimeoutRef.current = null
        }
        setMessageCountSummary(assistantMessageId, payload.summary)
      }),
      window.electronAPI.on('chat:sources', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        if (firstTokenTimeoutRef.current) {
          window.clearTimeout(firstTokenTimeoutRef.current)
          firstTokenTimeoutRef.current = null
        }
        setMessageSources(assistantMessageId, payload.sources, payload.inventoryCount)
      }),
      window.electronAPI.on('chat:chunk', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        if (firstTokenTimeoutRef.current) {
          window.clearTimeout(firstTokenTimeoutRef.current)
          firstTokenTimeoutRef.current = null
        }
        appendToMessage(assistantMessageId, payload.content)
      }),
      window.electronAPI.on('chat:done', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        updateMessage(
          assistantMessageId,
          payload.content,
          payload.clarificationOptions,
          'complete',
          payload.sources,
          payload.offerSearchAll,
          payload.inventoryCount
        )
        trackEvent('chat_response_completed', {
          selected_recording: Boolean(params.selectedMeetingId),
          clarification_options_count: payload.clarificationOptions?.length ?? 0
        })
        finishActiveRequest()
      }),
      window.electronAPI.on('chat:error', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        updateMessage(assistantMessageId, t('askAi.failed'), undefined, 'failed')
        console.error('Chat failed:', payload.error)
        trackEvent('chat_response_failed', { failure_code: 'stream_error' })
        finishActiveRequest()
      }),
      window.electronAPI.on('chat:canceled', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        setMessageStatus(assistantMessageId, 'canceled')
        removeEmptyInFlightAssistantMessages()
        trackEvent('chat_response_failed', { failure_code: 'canceled' })
        finishActiveRequest()
      })
    ]
    activeStreamCleanupRef.current = () => {
      for (const cleanup of cleanupListeners) cleanup()
    }
    firstTokenTimeoutRef.current = window.setTimeout(
      () => markActiveRequestTimedOut(requestId, assistantMessageId),
      FIRST_TOKEN_TIMEOUT_MS
    )
    completionTimeoutRef.current = window.setTimeout(
      () => markActiveRequestTimedOut(requestId, assistantMessageId),
      COMPLETION_TIMEOUT_MS
    )

    try {
      if (params.selectedMeetingId && !scope) {
        await window.electronAPI.invoke(
          'chat:select-recording-stream',
          requestId,
          params.selectedMeetingId,
          question,
          history
        )
      } else if (scope) {
        await window.electronAPI.invoke('chat:send-stream', requestId, question, history, [
          scope.meetingId
        ])
      } else if (params.searchAll) {
        // Unscoped on purpose: main must answer across meetings instead of clarifying again.
        await window.electronAPI.invoke(
          'chat:send-stream',
          requestId,
          question,
          history,
          undefined,
          true
        )
      } else {
        await window.electronAPI.invoke('chat:send-stream', requestId, question, history)
      }
    } catch (err) {
      if (activeRequestIdRef.current !== requestId) return
      updateMessage(assistantMessageId, t('askAi.failed'), undefined, 'failed')
      console.error('Chat failed:', err)
      trackEvent('chat_response_failed', { failure_code: 'invoke_failed' })
      finishActiveRequest()
    }
  }

  const handleSend = async (): Promise<void> => {
    const question = draftInput.trim()
    if (!question || loading) return
    setDraftInput('')
    await sendChatRequest({ question, displayQuestion: question })
  }

  const handleStop = (): void => {
    const requestId = activeRequestIdRef.current
    const assistantMessageId = activeAssistantMessageIdRef.current
    if (!requestId) return
    void window.electronAPI.invoke('chat:cancel', requestId)
    trackEvent('chat_response_failed', { failure_code: 'stopped' })
    if (assistantMessageId) {
      setMessageStatus(assistantMessageId, 'canceled')
    }
    removeEmptyInFlightAssistantMessages()
    finishActiveRequest()
  }

  const handleClarificationSelect = async (
    message: { originalQuestion?: string },
    option: ChatClarificationOption
  ): Promise<void> => {
    if (loading) return
    await sendChatRequest({
      question: message.originalQuestion ?? `Answer using ${option.title}`,
      displayQuestion: option.title,
      selectedMeetingId: option.meetingId
    })
  }

  const handleRemoveScope = (): void => {
    setMeetingScope(null)
    void window.electronAPI.invoke('chat:new')
    inputRef.current?.focus()
  }

  const handleSearchAll = async (
    messageId: string | undefined,
    question: string
  ): Promise<void> => {
    if (loading) return
    const index = messages.findIndex((message) => message.id === messageId)
    const history = messages.slice(0, Math.max(0, index - 1))
    setMeetingScope(null)
    await window.electronAPI.invoke('chat:new')
    await sendChatRequest({
      question,
      displayQuestion: question,
      scopeOverride: null,
      historyOverride: history,
      searchAll: true
    })
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewChat = async (): Promise<void> => {
    const activeRequestId = activeRequestIdRef.current
    if (activeRequestId) {
      void window.electronAPI.invoke('chat:cancel', activeRequestId)
      trackEvent('chat_response_failed', { failure_code: 'new_chat' })
    }
    activeStreamCleanupRef.current?.()
    activeStreamCleanupRef.current = null
    clearRequestTimeouts()
    isSendingRef.current = false
    activeRequestIdRef.current = null
    activeAssistantMessageIdRef.current = null
    clearMessages()
    setLoading(false)
    await window.electronAPI.invoke('chat:new')
    void refreshOllamaReady()
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={t('askAi.title')}
        titleAccessory={<BetaBadge />}
        action={
          <button
            type="button"
            onClick={handleNewChat}
            disabled={messages.length === 0 && !draftInput.trim() && !meetingScope}
            className="px-3 py-1.5 rounded-lg border border-border bg-bg-card text-[12px] font-medium text-ink hover:border-sage hover:bg-sage/5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark disabled:opacity-40"
          >
            {t('askAi.newChat')}
          </button>
        }
      />

      <AskAiBetaNotice onClosed={() => inputRef.current?.focus()} />
      <AskAiIndexNotice />
      {notesWork.length > 0 && (
        <div className="px-6 pt-3" role="status" data-ask-ai-notes-banner>
          <p className="rounded-xl border border-border bg-bg-accent px-3 py-2 text-[12px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
            {notesWork.length === 1
              ? t('askAi.notesPendingOne', { title: notesWork[0].title })
              : t('askAi.notesPendingMany', { count: notesWork.length })}
          </p>
        </div>
      )}
      {meetingScope && (
        <div className="px-6 pt-3" role="group" aria-label={t('askAi.scope')}>
          <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-sage/40 bg-sage/5 px-3 py-1.5 text-[12px] text-ink">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {t('askAi.onlyMeeting', { title: meetingScope.title })}
            </span>
            <button
              type="button"
              aria-label={t('askAi.removeScope')}
              onClick={handleRemoveScope}
              disabled={loading}
              className="shrink-0 rounded px-1 hover:bg-sage/10 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-12 h-12 rounded-full bg-dusk/10 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-dusk"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
                />
              </svg>
            </div>
            <p className="text-ink-muted text-[13px] text-center max-w-xs text-pretty">
              {t('askAi.emptyHint')}
            </p>
            {ollamaReady === false && (
              <p className="text-clay text-[11px] mt-1 text-pretty">{t('askAi.reconnecting')}</p>
            )}
          </div>
        )}

        {messages.length > 0 && (
          <div className="flex flex-col gap-4 max-w-2xl mx-auto">
            {messages.map((msg, i) => (
              <div
                key={msg.id ?? i}
                data-ask-ai-message={msg.role === 'assistant' ? msg.id : undefined}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`min-w-0 max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed [overflow-wrap:anywhere] ${
                    msg.role === 'user'
                      ? 'bg-sage text-on-brand rounded-br-md'
                      : 'bg-bg-card border border-border text-ink rounded-bl-md'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="space-y-3">
                      {msg.content.length === 0 &&
                      (msg.status === 'pending' || msg.status === 'streaming') ? (
                        <div className="flex gap-1.5 py-1">
                          <span
                            className="w-2 h-2 rounded-full bg-ink-faint animate-bounce"
                            style={{ animationDelay: '0ms' }}
                          />
                          <span
                            className="w-2 h-2 rounded-full bg-ink-faint animate-bounce"
                            style={{ animationDelay: '150ms' }}
                          />
                          <span
                            className="w-2 h-2 rounded-full bg-ink-faint animate-bounce"
                            style={{ animationDelay: '300ms' }}
                          />
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {renderNoteMarkup(
                            msg.status === 'failed'
                              ? t('askAi.failed')
                              : msg.status === 'timed_out'
                                ? t('askAi.timeout')
                                : displayAnswer(msg)
                          )}
                        </div>
                      )}
                      {msg.countSummary && (
                        <p
                          data-ask-ai-count-summary
                          role="note"
                          className="rounded-lg border border-border bg-bg px-3 py-2 text-[11px] text-ink-muted"
                        >
                          {t('askAi.countReceipt', {
                            count: msg.countSummary.count,
                            filter: askAiCountFilterCopy(msg.countSummary, t, language)
                          })}
                        </p>
                      )}
                      {msg.sources && msg.sources.length > 0 && (
                        <>
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {sourceLinks(msg.sources).map((source) => (
                              <button
                                key={`${source.n}-${source.meetingId}`}
                                data-ask-ai-source
                                data-meeting-id={source.meetingId}
                                type="button"
                                onClick={() => openSource(source)}
                                className="max-w-full rounded-full border border-border bg-bg px-2.5 py-1 text-left text-[11px] text-ink hover:border-sage hover:bg-sage/5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark"
                              >
                                <span className="font-medium">[{source.n}]</span>{' '}
                                <span className="text-ink-muted">{source.title}</span>
                                {formatSourceTime(source.startMs) && (
                                  <span className="text-ink-faint">
                                    {' '}
                                    · {formatSourceTime(source.startMs)}
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                          {!msg.meetingScope &&
                            !msg.scopedMeetingIds?.length &&
                            msg.inventoryCount !== undefined &&
                            msg.inventoryCount > 1 && (
                              <p
                                data-ask-ai-coverage
                                role="note"
                                className="rounded-lg border border-border bg-bg px-3 py-2 text-[11px] text-ink-muted"
                              >
                                {t('askAi.coverage', {
                                  passages: translatePlural(
                                    language,
                                    'passages',
                                    msg.sources.length
                                  ),
                                  meetings: new Set(msg.sources.map((source) => source.meetingId))
                                    .size,
                                  totalMeetings: translatePlural(
                                    language,
                                    'meetings',
                                    msg.inventoryCount
                                  )
                                })}
                              </p>
                            )}
                        </>
                      )}
                      {msg.clarificationOptions && msg.clarificationOptions.length > 0 && (
                        <div className="grid min-w-0 grid-cols-1 gap-2">
                          {msg.clarificationOptions.map((option) => (
                            <button
                              key={option.meetingId}
                              type="button"
                              disabled={loading}
                              onClick={() => handleClarificationSelect(msg, option)}
                              className="min-w-0 max-w-full text-left rounded-lg border border-border bg-bg px-3 py-2 [overflow-wrap:anywhere] hover:border-sage hover:bg-sage/5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark disabled:opacity-60"
                            >
                              <span className="block text-[13px] font-medium text-ink">
                                {option.title}
                              </span>
                              <span className="block text-[11px] text-ink-muted">
                                {option.subtitle}
                              </span>
                              {option.notePreview && (
                                <span
                                  title={option.notePreview}
                                  className="mt-1 block text-[11px] text-ink-muted line-clamp-2"
                                >
                                  {option.notePreview}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                      {(msg.meetingScope || msg.offerSearchAll) &&
                        msg.originalQuestion &&
                        msg.status === 'complete' && (
                          <button
                            type="button"
                            disabled={loading}
                            onClick={() => void handleSearchAll(msg.id, msg.originalQuestion!)}
                            className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:border-sage hover:bg-sage/5 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark"
                          >
                            {t('askAi.searchAll')}
                          </button>
                        )}
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-border">
        <div className="flex flex-wrap items-end justify-end gap-2 max-w-2xl mx-auto">
          <textarea
            ref={inputRef}
            rows={1}
            value={draftInput}
            onChange={(e) => {
              setDraftInput(e.target.value)
              reportTyping()
            }}
            onKeyDown={handleKeyDown}
            aria-label={t('askAi.placeholder')}
            placeholder={t('askAi.placeholder')}
            disabled={loading}
            className="flex-[1_1_14rem] min-w-0 max-w-full min-h-[44px] max-h-40 resize-none [field-sizing:content] px-4 py-2.5 bg-bg-card border-2 border-control-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-2 focus:outline-offset-2 focus:outline-sage transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-dark disabled:opacity-50"
            autoFocus
          />
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label={t('askAi.stopGenerating')}
              className="i18n-btn px-4 py-2.5 bg-clay text-on-brand rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5"
            >
              <span className="w-2.5 h-2.5 rounded-[2px] bg-on-brand" />
              {t('askAi.stop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!draftInput.trim()}
              className="i18n-btn px-4 py-2.5 bg-sage text-on-brand rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {t('askAi.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
