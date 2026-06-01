import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskAI } from './AskAI'
import { installMockElectronApi, resetRendererStores } from '../test/fixtures'

describe('AskAI', () => {
  beforeEach(() => {
    resetRendererStores()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
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

    expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2)
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('ollama:check-status')
    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'chat:send-stream',
      expect.any(String),
      'Who owns billing migration?',
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
})
