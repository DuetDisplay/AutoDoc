import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackPromptSlot } from './FeedbackPromptSlot'

const trackEvent = vi.fn()

vi.mock('../services/analytics', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args)
}))

type InvokeOverride = unknown | ((...args: unknown[]) => unknown)
type Listener = (...args: unknown[]) => void

interface InstalledApi {
  invoke: ReturnType<typeof vi.fn>
  emit: (channel: string, ...args: unknown[]) => void
}

let animationFrames = new Map<number, FrameRequestCallback>()
let nextAnimationFrameId = 1

function runAnimationFrame(): void {
  const queued = [...animationFrames.entries()]
  animationFrames.clear()
  for (const [, callback] of queued) callback(performance.now())
}

async function confirmRenderedPrompt(): Promise<void> {
  await waitFor(() => expect(animationFrames.size).toBeGreaterThan(0))
  act(runAnimationFrame)
  await waitFor(() => expect(animationFrames.size).toBeGreaterThan(0))
  act(runAnimationFrame)
  await waitFor(() => {
    expect(trackEvent).toHaveBeenCalledWith('feedback_prompt_shown', expect.any(Object))
  })
}

function installApi(overrides: Partial<Record<string, InvokeOverride>> = {}): InstalledApi {
  let promptReserved = false
  const listeners = new Map<string, Set<Listener>>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel in overrides) {
      const value = overrides[channel]
      return typeof value === 'function' ? await value(...args) : value
    }
    if (channel === 'feedback:observe-foreground') return undefined
    if (channel === 'feedback:reserve-prompt') {
      if (promptReserved) return { status: 'suppressed' }
      promptReserved = true
      return { status: 'reserved', reservationId: 'reservation-1', appearance: 'initial' }
    }
    if (channel === 'feedback:confirm-prompt') return { status: 'confirmed' }
    if (channel === 'feedback:cancel-prompt') return true
    if (channel === 'feedback:record-action') return true
    if (channel === 'support:open-email') return { status: 'opened' }
    if (channel === 'support:copy-email') return { status: 'copied' }
    return undefined
  })

  const on = vi.fn((channel: string, listener: Listener) => {
    const channelListeners = listeners.get(channel) ?? new Set<Listener>()
    channelListeners.add(listener)
    listeners.set(channel, channelListeners)
    return () => channelListeners.delete(listener)
  })

  window.electronAPI = {
    send: vi.fn(),
    invoke,
    on
  } as unknown as typeof window.electronAPI

  return {
    invoke,
    emit: (channel, ...args) => {
      for (const listener of listeners.get(channel) ?? []) listener(...args)
    }
  }
}

describe('FeedbackPromptSlot', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    trackEvent.mockReset()
    animationFrames = new Map()
    nextAnimationFrameId = 1
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextAnimationFrameId
      nextAnimationFrameId += 1
      animationFrames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      animationFrames.delete(id)
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible'
    })
  })

  it('reserves, confirms, and tracks one initial prompt on the first safe surface', async () => {
    const { invoke } = installApi()
    render(<FeedbackPromptSlot surface="upcoming" />)

    const prompt = await screen.findByRole('region', {
      name: 'How’s AutoDoc working for you?'
    })
    expect(prompt).toBeVisible()
    expect(prompt).toHaveAttribute('aria-busy', 'true')

    await confirmRenderedPrompt()

    expect(prompt).toHaveAttribute('aria-busy', 'false')
    expect(invoke).toHaveBeenCalledWith('feedback:observe-foreground')
    expect(invoke).toHaveBeenCalledWith('feedback:reserve-prompt', 'upcoming')
    expect(invoke).toHaveBeenCalledWith('feedback:confirm-prompt', 'reservation-1', 'upcoming')
    expect(trackEvent).toHaveBeenCalledWith('feedback_prompt_shown', {
      surface: 'upcoming',
      appearance: 'initial'
    })
  })

  it('does not reserve while the surface has critical UI', async () => {
    const { invoke } = installApi()
    render(<FeedbackPromptSlot surface="upcoming" suppressed />)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('feedback:observe-foreground')
    })
    expect(invoke).not.toHaveBeenCalledWith('feedback:reserve-prompt', 'upcoming')
    expect(screen.queryByText('How’s AutoDoc working for you?')).not.toBeInTheDocument()
  })

  it('cancels an in-flight reservation response after the surface unmounts', async () => {
    let resolveReservation!: (value: unknown) => void
    const reservationResponse = new Promise((resolve) => {
      resolveReservation = resolve
    })
    const { invoke } = installApi({
      'feedback:reserve-prompt': () => reservationResponse
    })
    const { unmount } = render(<FeedbackPromptSlot surface="upcoming" />)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('feedback:reserve-prompt', 'upcoming')
    })
    unmount()
    resolveReservation({
      status: 'reserved',
      reservationId: 'late-reservation',
      appearance: 'initial'
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('feedback:cancel-prompt', 'late-reservation', 'upcoming')
    })
    expect(trackEvent).not.toHaveBeenCalledWith('feedback_prompt_shown', expect.anything())
  })

  it('cancels before confirmation when suppression begins before paint settles', async () => {
    const { invoke } = installApi()
    const { rerender } = render(<FeedbackPromptSlot surface="upcoming" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })

    act(runAnimationFrame)
    rerender(<FeedbackPromptSlot surface="upcoming" suppressed />)
    act(runAnimationFrame)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('feedback:cancel-prompt', 'reservation-1', 'upcoming')
    })
    expect(invoke).not.toHaveBeenCalledWith('feedback:confirm-prompt', 'reservation-1', 'upcoming')
    expect(trackEvent).not.toHaveBeenCalledWith('feedback_prompt_shown', expect.anything())
  })

  it('removes a provisional card when main rejects confirmation', async () => {
    const { invoke } = installApi({
      'feedback:confirm-prompt': { status: 'rejected' }
    })
    render(<FeedbackPromptSlot surface="upcoming" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })

    act(runAnimationFrame)
    act(runAnimationFrame)

    await waitFor(() => {
      expect(screen.queryByText('How’s AutoDoc working for you?')).not.toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('feedback:confirm-prompt', 'reservation-1', 'upcoming')
    expect(trackEvent).not.toHaveBeenCalledWith('feedback_prompt_shown', expect.anything())
  })

  it('records Maybe later against the confirmed impression and hides the prompt', async () => {
    const user = userEvent.setup()
    const { invoke } = installApi()
    render(<FeedbackPromptSlot surface="ai_notes" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })
    await confirmRenderedPrompt()

    await user.click(screen.getByRole('button', { name: 'Maybe later' }))

    await waitFor(() => {
      expect(screen.queryByText('How’s AutoDoc working for you?')).not.toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('feedback:record-action', 'reservation-1', 'later')
    expect(trackEvent).toHaveBeenCalledWith('feedback_prompt_action', {
      surface: 'ai_notes',
      appearance: 'initial',
      action: 'later'
    })
  })

  it('tracks a successful feedback draft and removes the prompt', async () => {
    const user = userEvent.setup()
    const { invoke } = installApi()
    render(<FeedbackPromptSlot surface="upcoming" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })
    await confirmRenderedPrompt()

    await user.click(screen.getByRole('button', { name: 'Share feedback' }))

    await waitFor(() => {
      expect(screen.queryByText('How’s AutoDoc working for you?')).not.toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('support:open-email', 'upcoming')
    expect(trackEvent).toHaveBeenCalledWith('feedback_prompt_action', {
      surface: 'upcoming',
      appearance: 'initial',
      action: 'share_feedback'
    })
    expect(trackEvent).toHaveBeenCalledWith('support_email_requested', {
      surface: 'upcoming'
    })
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'upcoming',
      outcome: 'draft_opened'
    })
  })

  it('copies only through main after a mail-client failure', async () => {
    const user = userEvent.setup()
    const { invoke } = installApi({
      'support:open-email': {
        status: 'copy-required',
        address: 'team@getautodoc.com'
      },
      'support:copy-email': { status: 'copied' }
    })
    render(<FeedbackPromptSlot surface="ai_notes" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })
    await confirmRenderedPrompt()

    await user.click(screen.getByRole('button', { name: 'Share feedback' }))
    await user.click(await screen.findByRole('button', { name: 'Copy email address' }))

    expect(invoke).toHaveBeenCalledWith('support:copy-email', 'ai_notes')
    expect(invoke).not.toHaveBeenCalledWith('support:copy-email', 'ai_notes', 'team@getautodoc.com')
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'ai_notes',
      outcome: 'copy_required'
    })
    expect(trackEvent).toHaveBeenCalledWith('support_email_outcome', {
      surface: 'ai_notes',
      outcome: 'address_copied'
    })
  })

  it('removes a confirmed prompt when support is contacted elsewhere', async () => {
    const { emit } = installApi()
    render(<FeedbackPromptSlot surface="upcoming" />)
    await screen.findByRole('region', { name: 'How’s AutoDoc working for you?' })
    await confirmRenderedPrompt()

    act(() => emit('feedback:contact-initiated', 'sidebar'))

    expect(screen.queryByText('How’s AutoDoc working for you?')).not.toBeInTheDocument()
    expect(trackEvent).not.toHaveBeenCalledWith(
      'feedback_prompt_action',
      expect.objectContaining({ action: expect.anything() })
    )
  })
})
