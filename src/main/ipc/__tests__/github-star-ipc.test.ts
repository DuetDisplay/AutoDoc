import { beforeEach, describe, it, expect, vi } from 'vitest'
const { handlers, openExternal } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  openExternal: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn) },
  shell: { openExternal }
}))
vi.mock('electron-store', () => ({ default: class {} }))
import { registerGithubStarIpc } from '../github-star-ipc'
describe('GitHub star IPC', () => {
  const service = {
    reserve: vi.fn().mockResolvedValue('reservation'),
    confirm: vi.fn().mockResolvedValue(true),
    cancel: vi.fn()
  }
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    registerGithubStarIpc(service as any, (sender) => sender === ('main' as any))
  })
  it('opens only the fixed public repository URL, without accepting arbitrary renderer URLs', async () => {
    expect(
      await handlers.get('github-star:open')!({ sender: 'main' }, 'https://evil.example')
    ).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/DuetDisplay/AutoDoc')
  })
  it('rejects untrusted senders and malformed reservation IDs', async () => {
    expect(await handlers.get('github-star:reserve')!({ sender: 'other' })).toBeNull()
    expect(await handlers.get('github-star:confirm')!({ sender: 'main' }, {})).toBe(false)
    expect(await handlers.get('github-star:open')!({ sender: 'other' })).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
    expect(service.confirm).not.toHaveBeenCalled()
  })
  it('returns an honest retry result when the browser cannot open', async () => {
    openExternal.mockRejectedValueOnce(new Error('No browser'))
    expect(await handlers.get('github-star:open')!({ sender: 'main' })).toBe(false)
  })
})
