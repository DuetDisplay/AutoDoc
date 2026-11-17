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
    expect(retry).toHaveBeenCalledWith('meeting-123', 'direct', undefined)
  })

  it.each(['win32', 'darwin'])('preserves explicit Reprocess semantics on %s', async (platform) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      const retry = vi.fn()
      registerTranscriptionIpc({ retry } as never)
      await handlers.get('transcription:retry')?.({}, 'meeting', { reprocess: true })
      expect(retry.mock.calls[0]).toEqual(
        platform === 'win32'
          ? ['meeting', 'reprocess', undefined]
          : ['meeting', 'direct', undefined]
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })

  describe('reprocessing in another language', () => {
    function registerWithGuards(options?: {
      busy?: boolean
      activeJob?: boolean
      blockReason?: string | null
    }) {
      const retry = vi.fn()
      const isActiveJob = vi.fn(() => options?.activeJob ?? false)
      const isRecordingBusy = vi.fn(() => options?.busy ?? false)
      const getMeetingLanguageBlockReason = vi.fn(async () => options?.blockReason ?? null)
      const onManualRetry = vi.fn()
      registerTranscriptionIpc({ retry, isActiveJob } as never, onManualRetry, {
        isRecordingBusy,
        getMeetingLanguageBlockReason
      })
      const invoke = (options?: Record<string, unknown>) =>
        handlers.get('transcription:retry')!({}, 'meeting', options)
      return { retry, isRecordingBusy, getMeetingLanguageBlockReason, onManualRetry, invoke }
    }

    it('passes the requested language to the retry after checking availability', async () => {
      const { retry, getMeetingLanguageBlockReason, onManualRetry, invoke } = registerWithGuards()
      await invoke({ meetingLanguage: 'de' })
      expect(getMeetingLanguageBlockReason).toHaveBeenCalledWith('de')
      expect(onManualRetry).toHaveBeenCalledWith('meeting')
      expect(retry).toHaveBeenCalledWith('meeting', 'direct', 'de')
    })

    it('retries without a language as before', async () => {
      const { retry, getMeetingLanguageBlockReason, invoke } = registerWithGuards()
      await invoke()
      expect(getMeetingLanguageBlockReason).not.toHaveBeenCalled()
      expect(retry).toHaveBeenCalledWith('meeting', 'direct', undefined)
    })

    it('rejects unsupported codes and languages this computer cannot process', async () => {
      const blocked = registerWithGuards({ blockReason: 'Meeting language ja needs 16 GB' })
      await expect(blocked.invoke({ meetingLanguage: 'xx' })).rejects.toThrow('not supported')
      await expect(blocked.invoke({ meetingLanguage: 'ja' })).rejects.toThrow('needs 16 GB')
      expect(blocked.retry).not.toHaveBeenCalled()
      expect(blocked.onManualRetry).not.toHaveBeenCalled()
    })

    it.each([
      ['recording is saved or post-processed', { busy: true }],
      ['transcription job is active', { activeJob: true }]
    ])('refuses a language change while the %s', async (_label, options) => {
      const { retry, invoke } = registerWithGuards(options)
      await expect(invoke({ meetingLanguage: 'de' })).rejects.toThrow(
        'cannot be changed while the recording is saved or processed'
      )
      expect(retry).not.toHaveBeenCalled()
    })

    it('checks again right before the retry, after the availability check awaited', async () => {
      const { retry, isRecordingBusy, invoke } = registerWithGuards()
      isRecordingBusy.mockReturnValueOnce(false).mockReturnValueOnce(true)
      await expect(invoke({ meetingLanguage: 'de' })).rejects.toThrow('cannot be changed')
      expect(isRecordingBusy).toHaveBeenCalledTimes(2)
      expect(retry).not.toHaveBeenCalled()
    })
  })
})
