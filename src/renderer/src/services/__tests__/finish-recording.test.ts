import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finishRecording, trackRecordingStart } from '../finish-recording'
import { stopCapture } from '../recording-capture'
import { createElectronApiMock } from '../../test/fixtures'

vi.mock('../recording-capture', () => ({ stopCapture: vi.fn(), isCapturing: () => true }))

describe('recording stop handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('waits for capture startup from any recording hook before flushing', async () => {
    let start!: () => void
    trackRecordingStart(
      new Promise<void>((resolve) => {
        start = resolve
      })
    )
    vi.mocked(stopCapture).mockResolvedValue(undefined)
    window.electronAPI = createElectronApiMock({
      'recording:get-state': { isRecording: false }
    }) as any
    const stop = finishRecording()
    await Promise.resolve()
    expect(stopCapture).not.toHaveBeenCalled()
    start()
    await stop
    expect(stopCapture).toHaveBeenCalledOnce()
  })

  it.each(['MacIntel', 'Win32'])(
    'flushes capture in the required order on %s and joins concurrent stops',
    async (platform) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
      const order: string[] = []
      let flushed!: () => void
      vi.mocked(stopCapture).mockImplementation(() => {
        order.push('flush')
        return new Promise<void>((resolve) => {
          flushed = resolve
        })
      })
      const api = createElectronApiMock({
        'recording:get-state': { isRecording: true },
        'recording:stop': () => {
          order.push('stop')
          return { meetingId: 'recording' }
        },
        'recording:finalize-stop': () => {
          order.push('finalize')
        }
      })
      window.electronAPI = api as any
      const one = finishRecording()
      const two = finishRecording()
      expect(one).toBe(two)
      await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledTimes(1))
      expect(order).toEqual(platform === 'Win32' ? ['stop', 'flush'] : ['flush'])
      flushed()
      await one
      expect(order).toEqual(
        platform === 'Win32' ? ['stop', 'flush', 'finalize'] : ['flush', 'stop']
      )
      vi.restoreAllMocks()
    }
  )
})
