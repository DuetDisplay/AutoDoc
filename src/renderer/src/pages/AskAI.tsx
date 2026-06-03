import { useState, useRef, useEffect, type KeyboardEvent, type ReactElement } from 'react'
import { PageHeader } from '../components/PageHeader'
import { useChatStore } from '../stores/chat'
import { trackEvent } from '../services/analytics'
import { recordDiagnosticAction } from '../services/diagnostic-trail'
import type { ChatClarificationOption } from '../../../preload/ipc'

let fallbackRequestIdCounter = 0
const FIRST_TOKEN_TIMEOUT_MS = 45_000
const COMPLETION_TIMEOUT_MS = 180_000

function createChatRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return randomId

  fallbackRequestIdCounter += 1
  return `chat-${fallbackRequestIdCounter}`
}

export function AskAI(): ReactElement {
  const {
    messages,
    draftInput,
    addMessage,
    updateMessage,
    appendToMessage,
    setMessageStatus,
    removeEmptyInFlightAssistantMessages,
    setDraftInput,
    clearMessages
  } = useChatStore()
  const [loading, setLoading] = useState(false)
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeStreamCleanupRef = useRef<(() => void) | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const activeAssistantMessageIdRef = useRef<string | null>(null)
  const firstTokenTimeoutRef = useRef<number | null>(null)
  const completionTimeoutRef = useRef<number | null>(null)
  const isSendingRef = useRef(false)

  useEffect(() => {
    window.electronAPI.invoke('ollama:check-status').then(setOllamaReady)
  }, [])

  useEffect(() => {
    return () => {
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
  }, [removeEmptyInFlightAssistantMessages, setMessageStatus])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const clearRequestTimeouts = (): void => {
    if (firstTokenTimeoutRef.current) {
      window.clearTimeout(firstTokenTimeoutRef.current)
      firstTokenTimeoutRef.current = null
    }
    if (completionTimeoutRef.current) {
      window.clearTimeout(completionTimeoutRef.current)
      completionTimeoutRef.current = null
    }
  }

  const finishActiveRequest = (): void => {
    clearRequestTimeouts()
    isSendingRef.current = false
    setLoading(false)
    activeRequestIdRef.current = null
    activeAssistantMessageIdRef.current = null
    activeStreamCleanupRef.current?.()
    activeStreamCleanupRef.current = null
    inputRef.current?.focus()
  }

  const markActiveRequestTimedOut = (requestId: string, messageId: string): void => {
    if (activeRequestIdRef.current !== requestId) return
    updateMessage(
      messageId,
      'Sorry, this is taking longer than expected. Please try again.',
      undefined,
      'timed_out'
    )
    finishActiveRequest()
  }

  const sendChatRequest = async (params: {
    question: string
    displayQuestion: string
    selectedMeetingId?: string
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
    const history = messages
      .filter((message) => message.content.trim().length > 0 && message.status !== 'timed_out')
      .slice(-8)
      .map((message) => ({ role: message.role, content: message.content }))
    addMessage({ role: 'user', content: params.displayQuestion })
    addMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      status: 'pending',
      originalQuestion: question
    })
    setLoading(true)
    recordDiagnosticAction({
      category: 'chat',
      action: 'chat_message_sent',
      details: {
        questionLength: question.length
      }
    })
    trackEvent('chat_message_sent')

    const cleanupListeners = [
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
        updateMessage(assistantMessageId, payload.content, payload.clarificationOptions, 'complete')
        finishActiveRequest()
      }),
      window.electronAPI.on('chat:error', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        updateMessage(
          assistantMessageId,
          'Sorry, I had trouble answering that. Make sure Ollama is running and try again.',
          undefined,
          'failed'
        )
        console.error('Chat failed:', payload.error)
        finishActiveRequest()
      }),
      window.electronAPI.on('chat:canceled', (payload) => {
        if (payload.requestId !== requestId) return
        if (activeRequestIdRef.current !== requestId) return
        setMessageStatus(assistantMessageId, 'canceled')
        removeEmptyInFlightAssistantMessages()
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
      if (params.selectedMeetingId) {
        await window.electronAPI.invoke(
          'chat:select-recording-stream',
          requestId,
          params.selectedMeetingId,
          question,
          history
        )
      } else {
        await window.electronAPI.invoke('chat:send-stream', requestId, question, history)
      }
    } catch (err) {
      if (activeRequestIdRef.current !== requestId) return
      updateMessage(
        assistantMessageId,
        'Sorry, I had trouble answering that. Make sure Ollama is running and try again.',
        undefined,
        'failed'
      )
      console.error('Chat failed:', err)
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

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewChat = async (): Promise<void> => {
    activeStreamCleanupRef.current?.()
    activeStreamCleanupRef.current = null
    clearRequestTimeouts()
    isSendingRef.current = false
    activeRequestIdRef.current = null
    activeAssistantMessageIdRef.current = null
    clearMessages()
    setLoading(false)
    await window.electronAPI.invoke('chat:new')
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Ask AI"
        action={
          <button
            type="button"
            onClick={handleNewChat}
            disabled={messages.length === 0 && !draftInput.trim()}
            className="px-3 py-1.5 rounded-lg border border-border bg-bg-card text-[12px] font-medium text-ink hover:border-sage hover:bg-sage/5 transition-colors disabled:opacity-40"
          >
            New chat
          </button>
        }
      />

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
            <p className="text-ink-muted text-[13px] text-center max-w-xs">
              Ask questions about your meetings. I&apos;ll use your recent transcripts and notes to
              answer.
            </p>
            {ollamaReady === false && (
              <p className="text-clay text-[11px] mt-1">
                Local AI is reconnecting in the background. Try again in a few seconds.
              </p>
            )}
          </div>
        )}

        {messages.length > 0 && (
          <div className="flex flex-col gap-4 max-w-2xl mx-auto">
            {messages.map((msg, i) => (
              <div
                key={msg.id ?? i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-sage text-white rounded-br-md'
                      : 'bg-bg-card border border-border text-ink rounded-bl-md'
                  }`}
                >
                  {msg.role === 'assistant' &&
                  msg.content.length === 0 &&
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
                  ) : msg.role === 'assistant' ? (
                    <div className="space-y-3">
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                      {msg.clarificationOptions && msg.clarificationOptions.length > 0 && (
                        <div className="grid gap-2">
                          {msg.clarificationOptions.map((option) => (
                            <button
                              key={option.meetingId}
                              type="button"
                              disabled={loading}
                              onClick={() => handleClarificationSelect(msg, option)}
                              className="text-left rounded-lg border border-border bg-bg px-3 py-2 hover:border-sage hover:bg-sage/5 transition-colors disabled:opacity-60"
                            >
                              <span className="block text-[13px] font-medium text-ink">
                                {option.title}
                              </span>
                              <span className="block text-[11px] text-ink-muted">
                                {option.subtitle}
                              </span>
                              {option.notePreview && (
                                <span className="mt-1 block text-[11px] text-ink-muted line-clamp-2">
                                  {option.notePreview}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
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
        <div className="flex gap-2 max-w-2xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={draftInput}
            onChange={(e) => setDraftInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your meetings..."
            disabled={loading}
            className="flex-1 px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-sage transition-colors disabled:opacity-50"
            autoFocus
          />
          {loading ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop generating"
              className="px-4 py-2.5 bg-clay text-white rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5"
            >
              <span className="w-2.5 h-2.5 rounded-[2px] bg-white" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!draftInput.trim()}
              className="px-4 py-2.5 bg-sage text-white rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
