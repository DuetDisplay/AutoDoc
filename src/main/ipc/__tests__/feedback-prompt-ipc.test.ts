import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

import { registerFeedbackPromptIpc } from '../feedback-prompt-ipc'

const trustedSender = { id: 1 }
const untrustedSender = { id: 2 }

function handler(channel: string): (...args: any[]) => unknown {
  const registered = handlers.get(channel)
  if (!registered) throw new Error(`Missing handler for ${channel}`)
  return registered
}

function createService() {
  return {
    reservePrompt: vi.fn().mockResolvedValue({
      eligible: true,
      kind: 'initial',
      reason: 'eligible-initial',
      reserved: true,
      reservationId: 'reservation-1'
    }),
    confirmPrompt: vi.fn().mockResolvedValue({
      eligible: true,
      kind: 'initial',
      reason: 'eligible-initial',
      confirmed: true,
      impressionId: 'reservation-1'
    }),
    cancelPrompt: vi.fn().mockResolvedValue(true),
    recordAction: vi.fn().mockResolvedValue(true)
  }
}

function register(service = createService()) {
  registerFeedbackPromptIpc(service as any, {
    isTrustedSender: (sender) => sender === trustedSender,
    observeForeground: vi.fn()
  })
  return service
}

describe('feedback prompt IPC', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('reserves only bounded surfaces from the trusted app window', async () => {
    const service = register()

    await expect(
      handler('feedback:reserve-prompt')({ sender: trustedSender }, 'upcoming')
    ).resolves.toEqual({
      status: 'reserved',
      reservationId: 'reservation-1',
      appearance: 'initial'
    })
    await expect(
      handler('feedback:reserve-prompt')({ sender: trustedSender }, 'settings')
    ).resolves.toEqual({ status: 'suppressed' })
    await expect(
      handler('feedback:reserve-prompt')({ sender: untrustedSender }, 'upcoming')
    ).resolves.toEqual({ status: 'suppressed' })
    expect(service.reservePrompt).toHaveBeenCalledOnce()
    expect(service.reservePrompt).toHaveBeenCalledWith('upcoming')
  })

  it('fails quietly when main cannot reserve the prompt', async () => {
    const service = createService()
    service.reservePrompt.mockResolvedValueOnce({
      eligible: false,
      kind: null,
      reason: 'busy',
      reserved: false,
      reservationId: null
    } as never)
    register(service)

    await expect(
      handler('feedback:reserve-prompt')({ sender: trustedSender }, 'ai_notes')
    ).resolves.toEqual({ status: 'suppressed' })
  })

  it('confirms and cancels only bounded reservations from their trusted surface', async () => {
    const service = register()

    await expect(
      handler('feedback:confirm-prompt')({ sender: trustedSender }, 'reservation-1', 'upcoming')
    ).resolves.toEqual({ status: 'confirmed' })
    await expect(
      handler('feedback:cancel-prompt')({ sender: trustedSender }, 'reservation-1', 'upcoming')
    ).resolves.toBe(true)

    for (const [sender, id, surface] of [
      [untrustedSender, 'reservation-1', 'upcoming'],
      [trustedSender, '', 'upcoming'],
      [trustedSender, ' reservation-1', 'upcoming'],
      [trustedSender, 'reservation-1', 'settings']
    ]) {
      await expect(handler('feedback:confirm-prompt')({ sender }, id, surface)).resolves.toEqual({
        status: 'rejected'
      })
      await expect(handler('feedback:cancel-prompt')({ sender }, id, surface)).resolves.toBe(false)
    }

    expect(service.confirmPrompt).toHaveBeenCalledOnce()
    expect(service.confirmPrompt).toHaveBeenCalledWith('reservation-1', 'upcoming')
    expect(service.cancelPrompt).toHaveBeenCalledOnce()
    expect(service.cancelPrompt).toHaveBeenCalledWith('reservation-1', 'upcoming')
  })

  it('maps a main-process confirmation rejection without exposing its reason', async () => {
    const service = createService()
    service.confirmPrompt.mockResolvedValueOnce({
      eligible: false,
      kind: null,
      reason: 'busy',
      confirmed: false,
      impressionId: null
    } as never)
    register(service)

    await expect(
      handler('feedback:confirm-prompt')({ sender: trustedSender }, 'reservation-1', 'upcoming')
    ).resolves.toEqual({ status: 'rejected' })
  })

  it('binds bounded actions to a confirmed impression from the trusted window', async () => {
    const service = register()

    await expect(
      handler('feedback:record-action')({ sender: trustedSender }, 'reservation-1', 'never')
    ).resolves.toBe(true)
    await expect(
      handler('feedback:record-action')(
        { sender: trustedSender },
        'reservation-1',
        'share_feedback'
      )
    ).resolves.toBe(false)
    await expect(
      handler('feedback:record-action')({ sender: untrustedSender }, 'reservation-1', 'later')
    ).resolves.toBe(false)
    await expect(
      handler('feedback:record-action')({ sender: trustedSender }, '', 'later')
    ).resolves.toBe(false)
    expect(service.recordAction).toHaveBeenCalledOnce()
    expect(service.recordAction).toHaveBeenCalledWith('reservation-1', 'never')
  })

  it('starts foreground observation only for the trusted app window', () => {
    const observeForeground = vi.fn()
    registerFeedbackPromptIpc(createService() as any, {
      isTrustedSender: (sender) => sender === trustedSender,
      observeForeground
    })

    handler('feedback:observe-foreground')({ sender: untrustedSender })
    handler('feedback:observe-foreground')({ sender: trustedSender })
    expect(observeForeground).toHaveBeenCalledOnce()
  })
})
