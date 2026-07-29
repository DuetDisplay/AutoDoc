import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getVersion: vi.fn(() => '1.1.1'),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  getSupportEmail: vi.fn<() => string | null>(() => 'team@getautodoc.com'),
  isOfficialAutoDocBuild: vi.fn(() => false),
  requireSupportEmail: vi.fn(() => 'team@getautodoc.com'),
  logAutodocEvent: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: mocks.getVersion },
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

beforeEach(() => {
  mocks.handlers.clear()
  mocks.getVersion.mockReset()
  mocks.getVersion.mockReturnValue('1.1.1')
  mocks.openExternal.mockReset()
  mocks.openExternal.mockResolvedValue(undefined)
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

  it('reports whether a validated support address is available', () => {
    registerSupportIpc()
    const handler = getHandler('support:get-availability')

    expect(handler({})).toBe(true)
    mocks.getSupportEmail.mockReturnValue(null)
    expect(handler({})).toBe(false)
  })

  it('validates support configuration when an official build starts', () => {
    mocks.isOfficialAutoDocBuild.mockReturnValue(true)
    mocks.requireSupportEmail.mockImplementation(() => {
      throw new Error('Support email is not configured')
    })

    expect(() => registerSupportIpc()).toThrow('Support email is not configured')
    expect(mocks.handlers.size).toBe(0)
  })

  it('opens a main-owned draft and ignores renderer-supplied content', async () => {
    registerSupportIpc()
    const handler = getHandler('support:open-email')

    await expect(
      handler({}, 'attacker@example.com', 'subject&bcc=attacker@example.com')
    ).resolves.toEqual({ status: 'opened' })
    expect(mocks.openExternal).toHaveBeenCalledOnce()

    const openedUrl = mocks.openExternal.mock.calls[0][0]
    expect(openedUrl).toContain('mailto:team@getautodoc.com?subject=')
    expect(openedUrl).not.toContain('attacker')
    expect(openedUrl).not.toContain('body=')
  })

  it('returns only the validated address when the mail client cannot be opened', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('No default mail client'))
    registerSupportIpc()

    await expect(getHandler('support:open-email')({})).resolves.toEqual({
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
    registerSupportIpc()

    await expect(getHandler('support:open-email')({})).resolves.toEqual({
      status: 'unavailable'
    })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
