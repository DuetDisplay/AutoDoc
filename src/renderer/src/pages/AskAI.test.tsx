import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AskAI } from './AskAI'
import { installMockElectronApi, resetRendererStores } from '../test/fixtures'

describe('AskAI', () => {
  beforeEach(() => {
    resetRendererStores()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('shows the reconnecting hint when Ollama is not ready yet', async () => {
    installMockElectronApi({
      'ollama:check-status': false,
    })

    render(<AskAI />)

    expect(await screen.findByText(/local AI is reconnecting in the background/i)).toBeInTheDocument()
  })

  it('sends a grounded question and renders the assistant answer', async () => {
    installMockElectronApi({
      'ollama:check-status': true,
      'chat:send': (question: string) => `Answer for: ${question}`,
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/ask a question about your meetings/i), 'What changed in onboarding?')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('What changed in onboarding?')).toBeInTheDocument()
    expect(await screen.findByText('Answer for: What changed in onboarding?')).toBeInTheDocument()
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('chat:send', 'What changed in onboarding?')
  })

  it('falls back to the recovery message when the AI request fails', async () => {
    installMockElectronApi({
      'ollama:check-status': true,
      'chat:send': () => Promise.reject(new Error('boom')),
    })

    render(<AskAI />)

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/ask a question about your meetings/i), 'Summarize my last meeting')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(screen.getByText(/make sure Ollama is running and try again/i)).toBeInTheDocument()
    })
  })
})
