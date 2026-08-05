import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getVersion: vi.fn(() => '1.1.1'),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  writeText: vi.fn<(text: string) => void>(),
  getSupportEmail: vi.fn<() => string | null>(() => 'team@getautodoc.com'),
  isOfficialAutoDocBuild: vi.fn(() => false),
  requireSupportEmail: vi.fn(() => 'team@getautodoc.com'),
  logAutodocEvent: vi.fn()
}))

const trustedSender = { id: 1 }
const untrustedSender = { id: 2 }

vi.mock('electron', () => ({
  app: { getVersion: mocks.getVersion },
  clipboard: { writeText: mocks.writeText },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    })
  },
  shell: { openExternal: mocks.openExternal }
}))

vi.mock('../../services/distribution-config', () => ({
  getSupportEmail: mocks.getSupportEmail,
  isOfficialAutoDocBuild: mocks.isOfficialAutoDocBuild,
  requireSupportEmail: mocks.requireSupportEmail
}))

vi.mock('../../services/autodoc-log', () => ({
  logAutodocEvent: mocks.logAutodocEvent
}))

import { buildSupportMailtoUrl, getSupportPlatformLabel, registerSupportIpc } from '../support-ipc'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler
}

function registerSupportIpcForTest(
  options: {
    onContactInitiated?: (
      surface: 'sidebar' | 'onboarding' | 'upcoming' | 'ai_notes'
    ) => void | Promise<void>
  } = {}
): void {
  registerSupportIpc({
    isTrustedSender: (sender) => sender === trustedSender,
    ...options
  })
}

function trustedEvent(): { sender: typeof trustedSender } {
  return { sender: trustedSender }
}

function untrustedEvent(): { sender: typeof untrustedSender } {
  return { sender: untrustedSender }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.getVersion.mockReset()
  mocks.getVersion.mockReturnValue('1.1.1')
  mocks.openExternal.mockReset()
  mocks.openExternal.mockResolvedValue(undefined)
  mocks.writeText.mockReset()
  mocks.getSupportEmail.mockReset()
  mocks.getSupportEmail.mockReturnValue('team@getautodoc.com')
  mocks.isOfficialAutoDocBuild.mockReset()
  mocks.isOfficialAutoDocBuild.mockReturnValue(false)
  mocks.requireSupportEmail.mockReset()
  mocks.requireSupportEmail.mockReturnValue('team@getautodoc.com')
  mocks.logAutodocEvent.mockReset()
})

describe('support IPC', () => {
  it('builds an encoded macOS draft URL without a message body', () => {
    expect(buildSupportMailtoUrl('team@getautodoc.com', '1.1.1', 'darwin')).toBe(
      'mailto:team@getautodoc.com?subject=AutoDoc%20feedback%20%E2%80%94%20v1.1.1%20%E2%80%94%20macOS'
    )
    expect(getSupportPlatformLabel('darwin')).toBe('macOS')
  })

  it('builds the Windows subject from the packaged app version', () => {
    expect(buildSupportMailtoUrl('team@getautodoc.com', '1.1.1-internal.2', 'win32')).toBe(
      'mailto:team@getautodoc.com?subject=AutoDoc%20feedback%20%E2%80%94%20v1.1.1-internal.2%20%E2%80%94%20Windows'
    )
    expect(getSupportPlatformLabel('win32')).toBe('Windows')
  })

  it('adds only the fixed main-owned feedback prompts for proactive feedback', () => {
    const url = buildSupportMailtoUrl('team@getautodoc.com', '1.1.1', 'darwin', 'upcoming')
    const decoded = decodeURIComponent(url)

    expect(decoded).toContain(
      '&body=What were you hoping AutoDoc would help with?\n\nWhat’s working well?\n\nWhat’s missing or getting in the way?'
    )
    expect(
      buildSupportMailtoUrl('team@getautodoc.com', '1.1.1', 'darwin', 'onboarding')
    ).not.toContain('body=')
  })

  it('reports whether a validated support address is available', () => {
    registerSupportIpcForTest()
    const handler = getHandler('support:get-availability')

    expect(handler(trustedEvent())).toBe(true)
    mocks.getSupportEmail.mockReturnValue(null)
    expect(handler(trustedEvent())).toBe(false)
  })

  it('validates support configuration when an official build starts', () => {
    mocks.isOfficialAutoDocBuild.mockReturnValue(true)
    mocks.requireSupportEmail.mockImplementation(() => {
      throw new Error('Support email is not configured')
    })

    expect(() => registerSupportIpcForTest()).toThrow('Support email is not configured')
    expect(mocks.handlers.size).toBe(0)
  })

  it('rejects untrusted senders before reading configuration or causing side effects', async () => {
    const onContactInitiated = vi.fn()
    registerSupportIpcForTest({ onContactInitiated })

    expect(getHandler('support:get-availability')(untrustedEvent())).toBe(false)
    await expect(getHandler('support:open-email')(untrustedEvent(), 'upcoming')).resolves.toEqual({
      status: 'unavailable'
    })
    await expect(getHandler('support:copy-email')(untrustedEvent(), 'sidebar')).resolves.toEqual({
      status: 'unavailable'
    })

    expect(mocks.getSupportEmail).not.toHaveBeenCalled()
    expect(mocks.getVersion).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(onContactInitiated).not.toHaveBeenCalled()
    expect(mocks.logAutodocEvent).not.toHaveBeenCalled()
  })

  it('opens a main-owned sidebar draft and ignores renderer-supplied content', async () => {
    registerSupportIpcForTest()
    const handler = getHandler('support:open-email')

    await expect(
      handler(trustedEvent(), 'sidebar', 'attacker@example.com', 'subject&bcc=attacker@example.com')
    ).resolves.toEqual({ status: 'opened' })
    expect(mocks.openExternal).toHaveBeenCalledOnce()

    const openedUrl = mocks.openExternal.mock.calls[0][0]
    expect(openedUrl).toContain('mailto:team@getautodoc.com?subject=')
    expect(openedUrl).not.toContain('attacker')
    expect(openedUrl).not.toContain('body=')
  })

  it('rejects an unrecognized renderer surface without opening a URL', async () => {
    registerSupportIpcForTest()

    await expect(getHandler('support:open-email')(trustedEvent(), 'settings')).resolves.toEqual({
      status: 'unavailable'
    })
    await expect(getHandler('support:copy-email')(trustedEvent(), 'settings')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.writeText).not.toHaveBeenCalled()
  })

  it('returns only the validated address when the mail client cannot be opened', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('No default mail client'))
    registerSupportIpcForTest()

    await expect(getHandler('support:open-email')(trustedEvent(), 'sidebar')).resolves.toEqual({
      status: 'copy-required',
      address: 'team@getautodoc.com'
    })
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith({
      area: 'app',
      level: 'warn',
      message: 'support_email_draft_open_failed',
      context: { platform: process.platform }
    })
    expect(JSON.stringify(mocks.logAutodocEvent.mock.calls)).not.toContain('mailto:')
  })

  it('does not open an empty recipient when support email is unavailable', async () => {
    mocks.getSupportEmail.mockReturnValue(null)
    registerSupportIpcForTest()

    await expect(getHandler('support:open-email')(trustedEvent(), 'sidebar')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('copies only the configured address in the main process', async () => {
    const onContactInitiated = vi.fn()
    registerSupportIpcForTest({ onContactInitiated })

    await expect(
      getHandler('support:copy-email')(trustedEvent(), 'sidebar', 'attacker@example.com')
    ).resolves.toEqual({ status: 'copied' })
    expect(mocks.writeText).toHaveBeenCalledWith('team@getautodoc.com')
    expect(onContactInitiated).toHaveBeenCalledWith('sidebar')
  })

  it('reports bounded copy failures and does not record contact', async () => {
    const onContactInitiated = vi.fn()
    mocks.writeText.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable')
    })
    registerSupportIpcForTest({ onContactInitiated })

    await expect(getHandler('support:copy-email')(trustedEvent(), 'sidebar')).resolves.toEqual({
      status: 'copy-failed'
    })
    expect(onContactInitiated).not.toHaveBeenCalled()
  })

  it('records contact only after the mail client opens', async () => {
    const onContactInitiated = vi.fn()
    let resolveOpen: (() => void) | undefined
    mocks.openExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
    )
    registerSupportIpcForTest({ onContactInitiated })

    const openResult = getHandler('support:open-email')(trustedEvent(), 'upcoming')
    await Promise.resolve()
    expect(onContactInitiated).not.toHaveBeenCalled()
    resolveOpen?.()
    await expect(openResult).resolves.toEqual({
      status: 'opened'
    })
    expect(onContactInitiated).toHaveBeenCalledWith('upcoming')

    mocks.openExternal.mockRejectedValueOnce(new Error('No mail client'))
    await expect(getHandler('support:open-email')(trustedEvent(), 'ai_notes')).resolves.toEqual({
      status: 'copy-required',
      address: 'team@getautodoc.com'
    })
    expect(onContactInitiated).toHaveBeenCalledTimes(1)
  })

  it('keeps successful open and copy results when the contact callback fails', async () => {
    const onContactInitiated = vi.fn().mockRejectedValue(new Error('state unavailable'))
    registerSupportIpcForTest({ onContactInitiated })

    await expect(getHandler('support:open-email')(trustedEvent(), 'onboarding')).resolves.toEqual({
      status: 'opened'
    })
    await expect(getHandler('support:copy-email')(trustedEvent(), 'sidebar')).resolves.toEqual({
      status: 'copied'
    })
    expect(mocks.logAutodocEvent).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'support_contact_callback_failed' })
    )
  })
})
