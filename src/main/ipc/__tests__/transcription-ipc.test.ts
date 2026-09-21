import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTranscriptionIpc } from '../transcription-ipc'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

describe('registerTranscriptionIpc', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('marks manual transcription retries before retrying transcription', async () => {
    const retry = vi.fn()
    const onManualRetry = vi.fn()

    registerTranscriptionIpc({ retry } as never, onManualRetry)

    await handlers.get('transcription:retry')?.({}, 'meeting-123')

    expect(onManualRetry).toHaveBeenCalledWith('meeting-123')
    expect(onManualRetry.mock.invocationCallOrder[0]).toBeLessThan(
      retry.mock.invocationCallOrder[0]
    )
    expect(retry).toHaveBeenCalledWith('meeting-123')
  })

  it.each(['win32', 'darwin'])('preserves explicit Reprocess semantics on %s', async (platform) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      const retry = vi.fn()
      registerTranscriptionIpc({ retry } as never)
      await handlers.get('transcription:retry')?.({}, 'meeting', { reprocess: true })
      expect(retry.mock.calls[0]).toEqual(
        platform === 'win32' ? ['meeting', 'reprocess'] : ['meeting']
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })
})
