import { useState, useRef, useEffect } from 'react'
import { PageHeader } from '../components/PageHeader'
import { useChatStore } from '../stores/chat'

export function AskAI() {
  const { messages, addMessage } = useChatStore()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.electronAPI.invoke('ollama:check-status').then(setOllamaReady)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const handleSend = async () => {
    const question = input.trim()
    if (!question || loading) return

    setInput('')
    addMessage({ role: 'user', content: question })
    setLoading(true)

    try {
      const response = await window.electronAPI.invoke('chat:send', question)
      addMessage({ role: 'assistant', content: response })
    } catch (err) {
      addMessage({
        role: 'assistant',
        content: 'Sorry, I had trouble answering that. Make sure Ollama is running and try again.',
      })
      console.error('Chat failed:', err)
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Ask AI" />

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
              Ask questions about your meetings. I&apos;ll use your recent transcripts and notes to answer.
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
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-sage text-white rounded-br-md'
                      : 'bg-bg-card border border-border text-ink rounded-bl-md'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-bg-card border border-border rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-ink-faint animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-full bg-ink-faint animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 rounded-full bg-ink-faint animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-border">
        <div className="flex gap-2 max-w-2xl mx-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your meetings..."
            disabled={loading}
            className="flex-1 px-4 py-2.5 bg-bg-card border border-border rounded-lg text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-sage transition-colors disabled:opacity-50"
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="px-4 py-2.5 bg-sage text-white rounded-lg text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
