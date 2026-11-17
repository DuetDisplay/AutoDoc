import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskAI } from './AskAI'
import { installMockElectronApi, resetRendererStores } from '../test/fixtures'
import { useChatStore } from '../stores/chat'
import { trackEvent } from '../services/analytics'

vi.mock('../services/analytics', async (original) => ({
  ...(await original<typeof import('../services/analytics')>()),
  trackEvent: vi.fn()
}))

describe('AskAI', () => {
  beforeEach(() => {
    resetRendererStores()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the reconnecting hint when Ollama is not ready yet', async () => {
    installMockElectronApi({
      'ollama:check-status': false
    })

    render(<AskAI />)

    expect(
      await screen.findByText(/local AI is reconnecting in the background/i)
    ).toBeInTheDocument()
  })

  it('shows the Beta badge beside the page title without renaming the heading', async () => {
    installMockElectronApi({ 'ollama:check-status': true })
    render(<AskAI />)
    expect(screen.getByRole('heading', { name: 'Ask AI' })).toBeInTheDocument()
    expect(document.querySelector('[data-beta-badge]')).toHaveTextContent('Beta')
  })

  it('clears a stale reconnecting hint when the actual health check recovers', async () => {
    let connected = false
    const api = installMockElectronApi({ 'ollama:check-status': false })
    api.setHandler('ollama:check-status', () => connected)
    render(<AskAI />)
    await screen.findByText(/local AI is reconnecting in the background/i)
    connected = true
    act(() => api.emit('ollama:setup-progress', { phase: 'ready', percent: 100 }))
    await waitFor(() =>
      expect(screen.queryByText(/local AI is reconnecting/i)).not.toBeInTheDocument()
    )
  })

  it('sends a grounded question and renders the assistant answer', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (requestId: string, question: string) => {
      queueMicrotask(() => {
        api.emit('chat:chunk', { requestId, content: 'Answer ' })
        api.emit('chat:chunk', { requestId, content: `for: ${question}` })
        api.emit('chat:done', { requestId, content: `Answer for: ${question}` })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'What changed in onboarding?'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('What changed in onboarding?')).toBeInTheDocument()
    expect(await screen.findByText('Answer for: What changed in onboarding?')).toBeInTheDocument()
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      'What changed in onboarding?',
      []
    )
  })

  it('ignores rapid duplicate submits while the first request is starting', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', () => new Promise(() => {}))

    render(<AskAI />)

    const input = screen.getByPlaceholderText(/ask a question about your meetings/i)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Who owns billing migration?' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(
      vi
        .mocked(window.electronAPI.invoke)
        .mock.calls.filter(([channel]) => channel === 'chat:send-stream')
    ).toHaveLength(1)
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('ollama:check-status')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:warmup')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      'Who owns billing migration?',
      []
    )
  })

  it('keeps IME composition and Shift+Enter in the draft until an intentional submit', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true })
    api.setHandler('chat:send-stream', () => new Promise(() => {}))
    render(<AskAI />)
    const input = screen.getByRole('textbox')
    await act(async () => {
      fireEvent.change(input, { target: { value: '회의 내용을 정리해 주세요' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    })
    expect(window.electronAPI.invoke).not.toHaveBeenCalledWith(
      'chat:send-stream',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    expect(input).toHaveValue('회의 내용을 정리해 주세요')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      '회의 내용을 정리해 주세요',
      []
    )
  })

  it('falls back to the recovery message when the AI request fails', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (requestId: string) => {
      queueMicrotask(() => {
        api.emit('chat:error', { requestId, error: 'boom' })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Summarize my last meeting'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(screen.getByText(/make sure Ollama is running and try again/i)).toBeInTheDocument()
    })
  })

  it('stops an in-flight response, cancels the backend, and keeps partial text', async () => {
    let requestId = ''
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (id: string) => {
      requestId = id
      queueMicrotask(() => {
        api.emit('chat:chunk', { requestId: id, content: 'Partial answer' })
      })
      return new Promise(() => {})
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Summarize everything'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Partial answer')).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /stop generating/i }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:cancel', requestId)
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()

    const assistantMessage = useChatStore
      .getState()
      .messages.find((message) => message.role === 'assistant')
    expect(assistantMessage?.status).toBe('canceled')
    expect(assistantMessage?.content).toBe('Partial answer')
  })

  it('removes the empty bubble when stopping before any token arrives', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', () => new Promise(() => {}))

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Summarize everything'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await user.click(await screen.findByRole('button', { name: /stop generating/i }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:cancel', expect.any(String))
    expect(
      useChatStore
        .getState()
        .messages.some((message) => message.role === 'assistant' && message.content.length === 0)
    ).toBe(false)
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('renders assistant markdown bold instead of raw asterisks', async () => {
    installMockElectronApi({
      'ollama:check-status': true
    })
    useChatStore.getState().addMessage({
      id: 'assistant-bold',
      role: 'assistant',
      content: 'Chris will **review the PR** after standup.',
      status: 'complete'
    })

    render(<AskAI />)
    await act(async () => {})

    expect(screen.getByText('review the PR')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*review the PR\*\*/)).not.toBeInTheDocument()
  })

  it('persists the draft when the Ask AI view remounts', async () => {
    installMockElectronApi({
      'ollama:check-status': true
    })

    const { unmount } = render(<AskAI />)
    await act(async () => {})
    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Draft about the second recording'
    )

    unmount()
    render(<AskAI />)
    await act(async () => {})

    expect(screen.getByPlaceholderText(/ask a question about your meetings/i)).toHaveValue(
      'Draft about the second recording'
    )
  })

  it('removes an empty pending assistant message when the view unmounts', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', () => new Promise(() => {}))

    const { unmount } = render(<AskAI />)
    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Who owns billing migration?'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(useChatStore.getState().messages.some((message) => message.status === 'pending')).toBe(
        true
      )
    })

    unmount()

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:cancel', expect.any(String))
    expect(
      useChatStore
        .getState()
        .messages.some((message) => message.role === 'assistant' && message.content.length === 0)
    ).toBe(false)
  })

  it('cancels the in-flight backend request when starting a new chat', async () => {
    let requestId = ''
    const api = installMockElectronApi({
      'ollama:check-status': true,
      'chat:new': undefined
    })
    api.setHandler('chat:send-stream', (id: string) => {
      requestId = id
      return new Promise(() => {})
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Summarize everything'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(useChatStore.getState().messages.some((message) => message.status === 'pending')).toBe(
        true
      )
    })

    await user.click(screen.getByRole('button', { name: /new chat/i }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:cancel', requestId)
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:new')
  })

  it('times out stalled responses and ignores late stream events', async () => {
    vi.useFakeTimers()
    let requestId = ''
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (id: string) => {
      requestId = id
      return new Promise(() => {})
    })

    render(<AskAI />)

    const input = screen.getByPlaceholderText(/ask a question about your meetings/i)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Summarize the second recording' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(requestId).not.toBe('')

    act(() => {
      vi.advanceTimersByTime(45_000)
    })

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:cancel', requestId)
    expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument()

    act(() => {
      api.emit('chat:done', { requestId, content: 'Late answer that should be ignored' })
    })

    expect(screen.queryByText('Late answer that should be ignored')).not.toBeInTheDocument()
  })

  it('never shows the [0] no-evidence marker while an answer streams (AD-202)', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    let requestId = ''
    api.setHandler('chat:send-stream', (id: string) => {
      requestId = id
      return new Promise(() => {})
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'what about parrots eating carrots?'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    act(() =>
      api.emit('chat:chunk', { requestId, content: 'Nothing about parrots is recorded. [' })
    )
    expect(await screen.findByText('Nothing about parrots is recorded.')).toBeInTheDocument()
    act(() => api.emit('chat:chunk', { requestId, content: '0]' }))
    expect(screen.getByText('Nothing about parrots is recorded.')).toBeInTheDocument()
    expect(screen.queryByText(/\[0\]/)).not.toBeInTheDocument()
  })

  it('shows source cards before the answer and opens the cited meeting', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (requestId: string) => {
      queueMicrotask(() => {
        api.emit('chat:sources', {
          requestId,
          inventoryCount: 1,
          sources: [
            {
              n: 1,
              meetingId: 'billing-sync',
              title: 'Billing Sync — May 27 at 10:00 AM',
              quote: 'Ship the invoice export this week.',
              startMs: 84_000,
              category: 'information'
            }
          ]
        })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Who owns the invoice export?'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    const chip = await screen.findByRole('button', { name: /billing sync/i })
    expect(chip).toHaveTextContent('1:24')
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument()
    expect(screen.queryByText('Priya will ship the invoice export [1].')).not.toBeInTheDocument()
    await user.click(chip)
    expect(window.location.hash).toBe('#/recordings/billing-sync?t=84000')
  })

  it('shows one source link per recording and displayed timestamp (AD-202)', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    const card = (n: number, meetingId: string, title: string, startMs: number | null) => ({
      n,
      meetingId,
      title,
      quote: `Passage ${n}`,
      startMs,
      category: 'information'
    })
    api.setHandler('chat:send-stream', (requestId: string) => {
      queueMicrotask(() => {
        api.emit('chat:sources', {
          requestId,
          inventoryCount: 2,
          sources: [
            card(1, 'coastal', 'Coastal Seas', 4_200),
            card(2, 'coastal', 'Coastal Seas', 4_900),
            card(3, 'coastal', 'Coastal Seas', 69_000),
            card(4, 'coastal', 'Coastal Seas', null),
            card(5, 'coastal', 'Coastal Seas', null),
            card(6, 'camping', 'Camping', 4_200)
          ]
        })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Give me the summary'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByRole('button', { name: /camping/i })
    const links = document.querySelectorAll('[data-ask-ai-source]')
    expect([...links].map((link) => link.textContent)).toEqual([
      '[1] Coastal Seas · 0:04',
      '[3] Coastal Seas · 1:09',
      '[4] Coastal Seas',
      '[6] Camping · 0:04'
    ])
    // Coverage still reports the retrieved passages, not the merged links.
    expect(document.querySelector('[data-ask-ai-coverage]')).toHaveTextContent('6 passages')
  })

  it('renders clarification options as selectable meetings and sends the meeting id', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true
    })
    api.setHandler('chat:send-stream', (requestId: string) => {
      queueMicrotask(() => {
        api.emit('chat:chunk', { requestId, content: 'Which one?' })
        api.emit('chat:done', {
          requestId,
          content: 'Which one?',
          clarificationOptions: [
            {
              meetingId: 'meeting-calendar-auth',
              title: 'Engineering Reliability Review',
              subtitle: 'Wed, May 27, 1:00 PM',
              date: new Date('2026-05-27T17:00:00Z').getTime(),
              sourceName: 'Entire screen',
              calendarTitle: 'Engineering Reliability Review',
              slackChannel: null,
              participants: ['casey@example.com'],
              notePreview: 'Investigate calendar auth scopes.',
              score: 42
            }
          ]
        })
      })
    })
    api.setHandler('chat:select-recording-stream', (requestId: string) => {
      queueMicrotask(() => {
        api.emit('chat:chunk', { requestId, content: 'Selected answer' })
        api.emit('chat:done', { requestId, content: 'Selected answer' })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Which meeting covered calendar permissions?'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await user.click(await screen.findByRole('button', { name: /engineering reliability review/i }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'chat:select-recording-stream',
      expect.any(String),
      'meeting-calendar-auth',
      'Which meeting covered calendar permissions?',
      expect.any(Array)
    )
    expect(await screen.findByText('Selected answer')).toBeInTheDocument()
  })

  it('starts a new chat by clearing visible and main-process context', async () => {
    const api = installMockElectronApi({
      'ollama:check-status': true,
      'chat:new': undefined
    })
    api.setHandler('chat:send-stream', (requestId: string, question: string) => {
      queueMicrotask(() => {
        api.emit('chat:done', { requestId, content: `Answer for: ${question}` })
      })
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Old context'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Answer for: Old context')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /new chat/i }))

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:new')
    expect(screen.queryByText('Old context')).not.toBeInTheDocument()
    expect(screen.queryByText('Answer for: Old context')).not.toBeInTheDocument()
  })
  it('keeps an attached meeting chip through follow-ups and clears it on New chat', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true })
    useChatStore.getState().startMeetingChat({ meetingId: 'scope-a', title: 'Lumen review' })
    api.setHandler('chat:send-stream', (requestId: string) =>
      queueMicrotask(() => api.emit('chat:done', { requestId, content: 'Mara owns the review.' }))
    )
    render(<AskAI />)
    expect(screen.getByRole('group', { name: 'Meeting scope' })).toHaveTextContent(
      'Only this meeting: Lumen review'
    )
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'Who owns this?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Mara owns the review.')
    expect(api.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      'Who owns this?',
      [],
      ['scope-a']
    )
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'What does she need to do?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(api.invoke).toHaveBeenCalledWith(
        'chat:send-stream',
        expect.any(String),
        'What does she need to do?',
        expect.any(Array),
        ['scope-a']
      )
    )
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.queryByRole('group', { name: 'Meeting scope' })).not.toBeInTheDocument()
    expect(useChatStore.getState().meetingScope).toBeNull()
  })
  it('removes the chip and re-asks the exact out-of-scope question with one Search all meetings click', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true })
    useChatStore.getState().startMeetingChat({ meetingId: 'scope-a', title: 'Lumen review' })
    api.setHandler(
      'chat:send-stream',
      (requestId: string, _question: string, _history: unknown, ids?: string[]) =>
        queueMicrotask(() =>
          api.emit('chat:done', {
            requestId,
            content: ids ? 'That answer is not in this meeting.' : 'Harbor has the requested code.'
          })
        )
    )
    render(<AskAI />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'What is the Harbor code?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('That answer is not in this meeting.')
    await user.click(screen.getByRole('button', { name: 'Search all meetings' }))
    await screen.findByText('Harbor has the requested code.')
    expect(screen.queryByRole('group', { name: 'Meeting scope' })).not.toBeInTheDocument()
    const requests = api.invoke.mock.calls.filter(([name]) => name === 'chat:send-stream')
    expect(requests[0]).toEqual([
      'chat:send-stream',
      expect.any(String),
      'What is the Harbor code?',
      [],
      ['scope-a']
    ])
    expect(requests[1]).toEqual([
      'chat:send-stream',
      expect.any(String),
      'What is the Harbor code?',
      [],
      undefined,
      true
    ])
  })
  it('offers Search all meetings on a subject clarification and re-asks it unscoped with searchAll', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true, 'chat:new': undefined })
    api.setHandler(
      'chat:send-stream',
      (requestId: string, _question: string, _history: unknown, _ids?: string[], all?: boolean) =>
        queueMicrotask(() =>
          api.emit(
            'chat:done',
            all
              ? { requestId, content: 'Across your meetings: Mara owns it.' }
              : {
                  requestId,
                  content: 'Which meeting or topic do you mean?',
                  offerSearchAll: true,
                  clarificationOptions: [
                    {
                      meetingId: 'm1',
                      title: 'Lumen review',
                      subtitle: 'Mon',
                      date: 0,
                      sourceName: null,
                      calendarTitle: null,
                      slackChannel: null,
                      participants: [],
                      notePreview: null,
                      score: 0
                    }
                  ]
                }
          )
        )
    )
    render(<AskAI />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'What are my action items?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: /lumen review/i })
    await user.click(screen.getByRole('button', { name: 'Search all meetings' }))
    await screen.findByText('Across your meetings: Mara owns it.')
    const requests = api.invoke.mock.calls.filter(([name]) => name === 'chat:send-stream')
    expect(requests[1]).toEqual([
      'chat:send-stream',
      expect.any(String),
      'What are my action items?',
      [],
      undefined,
      true
    ])
  })
  it('lets the user remove an unused meeting chip and starts the next turn globally', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true })
    useChatStore.getState().startMeetingChat({ meetingId: 'scope-a', title: 'Lumen review' })
    api.setHandler('chat:send-stream', (requestId: string) =>
      queueMicrotask(() => api.emit('chat:done', { requestId, content: 'Global answer.' }))
    )
    render(<AskAI />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove meeting scope' }))
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'What changed?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Global answer.')
    expect(api.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      'What changed?',
      []
    )
  })
  it('shows the native count and every actual filter even when the model prose omits a bound', async () => {
    const api = installMockElectronApi({ 'ollama:check-status': true })
    api.setHandler('chat:send-stream', (requestId: string) =>
      queueMicrotask(() => {
        api.emit('chat:count-result', {
          requestId,
          summary: {
            count: 2,
            filterDescription:
              'all saved recordings on or after 2026-09-01, on or before 2026-09-30, whose notes or transcript contain all keyword terms "budget"'
          }
        })
        api.emit('chat:done', { requestId, content: 'There are two recordings since September1.' })
      })
    )
    render(<AskAI />)
    const user = userEvent.setup()
    await user.type(
      screen.getByPlaceholderText(/ask a question/i),
      'Count recordings mentioning budget since September1.'
    )
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Counted 2: all saved recordings on or after 2026-09-01, on or before 2026-09-30'
    )
    expect(screen.getByRole('note')).toHaveTextContent('keyword terms "budget"')
    await user.type(screen.getByPlaceholderText(/ask a question/i), 'Which dates were used?')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    const calls = api.invoke.mock.calls.filter(([name]) => name === 'chat:send-stream')
    expect((calls.at(-1)![3] as Array<{ content: string }>).at(-1)?.content).toContain(
      'on or before 2026-09-30'
    )
  })
})

describe('Ask AI conversation notes banner and activity', () => {
  beforeEach(() => {
    resetRendererStores()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })
  afterEach(() => vi.useRealTimers())
  it('shows active or queued notes by title, handles several meetings, and hides when idle', async () => {
    let work = [{ meetingId: 'active', title: 'Synthetic launch review' }]
    const api = installMockElectronApi({ 'ollama:check-status': true })
    api.setHandler('chat:notes-work', () => work)
    render(<AskAI />)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Notes for Synthetic launch review are still being made.'
    )
    work = [...work, { meetingId: 'queued', title: 'Synthetic planning' }]
    act(() => api.emit('segmentation:status-changed', { meetingId: 'queued', status: 'queued' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Notes for 2 meetings are still being made.'
      )
    )
    work = []
    act(() => api.emit('segmentation:status-changed', { meetingId: 'active', status: 'complete' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
  it('reports typing at most once every ten seconds, keeps its last keystroke time, and closes on unmount', async () => {
    vi.useFakeTimers()
    const api = installMockElectronApi({ 'ollama:check-status': true })
    const { unmount } = render(<AskAI />)
    await act(async () => {})
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'a' } })
    const first = Date.now()
    expect(api.invoke.mock.calls.filter(([name]) => name === 'chat:activity')).toEqual([
      ['chat:activity', first]
    ])
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    fireEvent.change(input, { target: { value: 'ab' } })
    const last = Date.now()
    expect(api.invoke.mock.calls.filter(([name]) => name === 'chat:activity')).toHaveLength(1)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.invoke.mock.calls.filter(([name]) => name === 'chat:activity')).toEqual([
      ['chat:activity', first],
      ['chat:activity', last]
    ])
    unmount()
    expect(api.invoke).toHaveBeenCalledWith('chat:close')
  })
})

const coverageSource = (n: number, meetingId: string) => ({
  n,
  meetingId,
  title: 'Synthetic session',
  quote: 'Synthetic evidence.',
  startMs: null,
  category: 'information'
})
it('shows coverage matching rendered chips, with natural singulars, and hides it without chips or for scoped questions', () => {
  resetRendererStores()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  installMockElectronApi({ 'ollama:check-status': true })
  useChatStore.setState({
    messages: [
      {
        id: 'plural',
        role: 'assistant',
        content: 'Answer.',
        status: 'complete',
        sources: [coverageSource(1, 'a'), coverageSource(2, 'a'), coverageSource(3, 'b')],
        inventoryCount: 102
      },
      {
        id: 'singular',
        role: 'assistant',
        content: 'Answer.',
        status: 'complete',
        sources: [coverageSource(1, 'a')],
        inventoryCount: 102
      },
      {
        id: 'none',
        role: 'assistant',
        content: 'Which meeting?',
        status: 'complete',
        inventoryCount: 102
      },
      {
        id: 'scoped',
        role: 'assistant',
        content: 'Scoped answer.',
        status: 'complete',
        meetingScope: { meetingId: 'a', title: 'Synthetic session' },
        sources: [coverageSource(1, 'a')],
        inventoryCount: 102
      },
      {
        id: 'scoped-ids',
        role: 'assistant',
        content: 'Selected answer.',
        status: 'complete',
        scopedMeetingIds: ['a'],
        sources: [coverageSource(1, 'a')],
        inventoryCount: 102
      }
    ]
  })
  render(<AskAI />)
  expect(screen.getByText('Based on 3 passages from 2 of your 102 meetings.')).toBeInTheDocument()
  expect(screen.getByText('Based on 1 passage from 1 of your 102 meetings.')).toBeInTheDocument()
  expect(document.querySelectorAll('[data-ask-ai-coverage]')).toHaveLength(2)
})
it('never flashes a literal citation placeholder split across stream chunks', async () => {
  resetRendererStores()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  const api = installMockElectronApi({ 'ollama:check-status': true })
  let requestId = ''
  api.setHandler('chat:send-stream', (id: string) => {
    requestId = id
    return new Promise(() => {})
  })
  render(<AskAI />)
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Who owns the task?' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  })
  expect(requestId).toBeTruthy()
  for (const chunk of ['Mira [', 'n', ']']) {
    act(() => api.emit('chat:chunk', { requestId, content: chunk }))
    expect(document.querySelector('.whitespace-pre-wrap')).toHaveTextContent('Mira')
    expect(document.querySelector('.whitespace-pre-wrap')?.textContent).not.toContain('[')
  }
})

it('restores coverage for saved source chips that predate inventory metadata', async () => {
  resetRendererStores()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  installMockElectronApi({ 'ollama:check-status': true, 'chat:inventory-count': 102 })
  useChatStore.setState({
    messages: [
      {
        id: 'saved',
        role: 'assistant',
        content: 'Saved answer.',
        status: 'complete',
        sources: [coverageSource(1, 'a')]
      }
    ]
  })
  render(<AskAI />)
  expect(
    await screen.findByText('Based on 1 passage from 1 of your 102 meetings.')
  ).toBeInTheDocument()
})

it('hides coverage for a one-meeting library but keeps the source chips', () => {
  resetRendererStores()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  installMockElectronApi({ 'ollama:check-status': true })
  useChatStore.setState({
    messages: [
      {
        id: 'one',
        role: 'assistant',
        content: 'Answer.',
        status: 'complete',
        sources: [coverageSource(1, 'a')],
        inventoryCount: 1
      }
    ]
  })
  render(<AskAI />)
  expect(document.querySelectorAll('[data-ask-ai-source]')).toHaveLength(1)
  expect(document.querySelector('[data-ask-ai-coverage]')).toBeNull()
})

it('keeps saved source chips when the library count cannot be read', async () => {
  resetRendererStores()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  const api = installMockElectronApi({
    'ollama:check-status': true,
    'chat:inventory-count': () => Promise.reject(new Error('unavailable'))
  })
  useChatStore.setState({
    messages: [
      {
        id: 'saved',
        role: 'assistant',
        content: 'Saved answer.',
        status: 'complete',
        sources: [coverageSource(1, 'a')]
      }
    ]
  })
  render(<AskAI />)
  await waitFor(() => expect(api.invoke).toHaveBeenCalledWith('chat:inventory-count'))
  expect(document.querySelectorAll('[data-ask-ai-source]')).toHaveLength(1)
  expect(document.querySelector('[data-ask-ai-coverage]')).toBeNull()
})

describe('Ask AI unanswered request analytics', () => {
  beforeEach(() => {
    resetRendererStores()
    vi.mocked(trackEvent).mockClear()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
  })

  const failures = (): unknown[][] =>
    vi.mocked(trackEvent).mock.calls.filter(([name]) => name === 'chat_response_failed')

  async function startRequest(): Promise<{
    api: ReturnType<typeof installMockElectronApi>
    unmount: () => void
    requestId: () => string
  }> {
    let requestId = ''
    const api = installMockElectronApi({ 'ollama:check-status': true, 'chat:new': undefined })
    api.setHandler('chat:send-stream', (id: string) => {
      requestId = id
      return new Promise(() => {})
    })
    const { unmount } = render(<AskAI />)
    await userEvent.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'Summarize everything'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: /stop generating/i })
    return { api, unmount, requestId: () => requestId }
  }

  it('records stopped, new_chat and left_page once each while a request is active', async () => {
    const stop = await startRequest()
    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }))
    expect(failures()).toEqual([['chat_response_failed', { failure_code: 'stopped' }]])
    stop.unmount()
    expect(failures()).toHaveLength(1)

    vi.mocked(trackEvent).mockClear()
    const next = await startRequest()
    await userEvent.click(screen.getByRole('button', { name: /new chat/i }))
    expect(failures()).toEqual([['chat_response_failed', { failure_code: 'new_chat' }]])
    next.unmount()
    expect(failures()).toHaveLength(1)

    vi.mocked(trackEvent).mockClear()
    const leave = await startRequest()
    leave.unmount()
    expect(failures()).toEqual([['chat_response_failed', { failure_code: 'left_page' }]])
  })

  it('records nothing when no request is active', async () => {
    installMockElectronApi({ 'ollama:check-status': true, 'chat:new': undefined })
    const { unmount } = render(<AskAI />)
    await userEvent.type(
      screen.getByPlaceholderText(/ask a question about your meetings/i),
      'draft'
    )
    await userEvent.click(screen.getByRole('button', { name: /new chat/i }))
    unmount()
    expect(failures()).toEqual([])
  })

  it('records nothing when unmounting after a completed response', async () => {
    const { api, unmount, requestId } = await startRequest()
    act(() => api.emit('chat:done', { requestId: requestId(), content: 'Done' }))
    await screen.findByText('Done')
    unmount()
    expect(failures()).toEqual([])
  })
})
