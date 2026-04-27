import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MockTrack extends EventTarget {
  kind: 'audio' | 'video'
  readyState: 'live' | 'ended' = 'live'

  constructor(kind: 'audio' | 'video') {
    super()
    this.kind = kind
  }

  stop(): void {
    if (this.readyState === 'ended') return
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

class MockMediaStream {
  private readonly tracks: MockTrack[]

  constructor(tracks: MockTrack[] = []) {
    this.tracks = tracks
  }

  getTracks(): MockTrack[] {
    return [...this.tracks]
  }

  getAudioTracks(): MockTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getVideoTracks(): MockTrack[] {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

class MockMediaRecorder extends EventTarget {
  static isTypeSupported(_mimeType: string): boolean {
    return true
  }

  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null

  constructor(_stream: MockMediaStream, options?: MediaRecorderOptions) {
    super()
    this.mimeType = options?.mimeType ?? 'video/webm'
  }

  start(): void {
    this.state = 'recording'
  }

  requestData(): void {
    // No-op for test coverage.
  }

  stop(): void {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

function createMockStreamForConstraints(
  constraints: MediaStreamConstraints | undefined
): MockMediaStream {
  if (constraints?.audio === false) {
    return new MockMediaStream([new MockTrack('video')])
  }

  if (constraints?.audio && constraints?.video) {
    return new MockMediaStream([new MockTrack('audio'), new MockTrack('video')])
  }

  return new MockMediaStream([new MockTrack('audio')])
}

describe('recording-capture', () => {
  let deviceChangeListeners: Array<() => void> = []
  let recoveryReject: ((reason?: unknown) => void) | null = null
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let getUserMediaMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()

    deviceChangeListeners = []
    recoveryReject = null

    getUserMediaMock = vi.fn((constraints: MediaStreamConstraints) =>
      Promise.resolve(createMockStreamForConstraints(constraints))
    )

    const mediaDevices = {
      getUserMedia: getUserMediaMock,
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'default', groupId: 'mic-default', label: 'Mic' },
        { kind: 'audiooutput', deviceId: 'default', groupId: 'speaker-default', label: 'Speaker' },
      ]),
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        deviceChangeListeners.push(listener)
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        deviceChangeListeners = deviceChangeListeners.filter((entry) => entry !== listener)
      }),
    }

    vi.stubGlobal('navigator', { mediaDevices })
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('does not show a recovery failure toast when stopping during capture recovery', async () => {
    const { startCapture, stopCapture } = await import('../recording-capture')
    const { useToastStore } = await import('../../stores/toast')

    useToastStore.setState({ activeToast: null })

    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1
      if (getUserMediaCallCount === 4) {
        return new Promise<MockMediaStream>((_, reject) => {
          recoveryReject = reject
        })
      }
      return Promise.resolve(createMockStreamForConstraints(constraints))
    })

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(750)
    await Promise.resolve()

    const stopPromise = stopCapture()

    recoveryReject?.(new Error('meeting already ended'))
    await Promise.resolve()
    await stopPromise

    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('does not show a recovery failure toast when recovery fails', async () => {
    const { startCapture } = await import('../recording-capture')
    const { useToastStore } = await import('../../stores/toast')

    useToastStore.setState({ activeToast: null })

    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1
      if (getUserMediaCallCount === 4) {
        return new Promise<MockMediaStream>((_, reject) => {
          recoveryReject = reject
        })
      }
      return Promise.resolve(createMockStreamForConstraints(constraints))
    })

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(750)
    await Promise.resolve()
    recoveryReject?.(new Error('route switch failed'))
    await Promise.resolve()

    expect(useToastStore.getState().activeToast).toBeNull()
  })

  it('retries capture recovery after a transient device-switch failure', async () => {
    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1
      if (getUserMediaCallCount === 4) {
        return Promise.reject(new Error('device route still switching'))
      }
      return Promise.resolve(createMockStreamForConstraints(constraints))
    })

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(2_250)
    await Promise.resolve()

    expect(getUserMediaMock).toHaveBeenCalledTimes(7)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Capture recovery attempt failed, retrying',
      expect.objectContaining({
        attempt: 1,
        reason: 'devicechange',
        error: 'device route still switching'
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('retries recovery until the microphone stream returns after a route change', async () => {
    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1

      if (getUserMediaCallCount <= 3) {
        return Promise.resolve(createMockStreamForConstraints(constraints))
      }

      if (getUserMediaCallCount <= 6) {
        if (constraints.audio === false) {
          return Promise.resolve(new MockMediaStream([new MockTrack('video')]))
        }
        if (constraints.audio && constraints.video) {
          return Promise.resolve(new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]))
        }
        return Promise.resolve(new MockMediaStream())
      }

      return Promise.resolve(createMockStreamForConstraints(constraints))
    })

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(2_250)
    await Promise.resolve()

    expect(getUserMediaMock).toHaveBeenCalledTimes(9)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Capture recovery is waiting for audio routes to settle',
      expect.objectContaining({
        attempt: 1,
        reason: 'devicechange',
        missingSources: ['mic']
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('still throws when capture start is requested while another capture is active', async () => {
    const { startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')
    await expect(startCapture('window:2', 'meeting-2')).rejects.toThrow('Capture already active')

    await stopCapture()
  })

  it('falls back to the next recorder MIME option when MediaRecorder.start throws', async () => {
    const recorderMimeTypes: string[] = []

    class StartFailMediaRecorder extends MockMediaRecorder {
      static override isTypeSupported(_mimeType: string): boolean {
        return true
      }

      constructor(stream: MockMediaStream, options?: MediaRecorderOptions) {
        super(stream, options)
        recorderMimeTypes.push(options?.mimeType ?? '')
      }

      override start(): void {
        if (this.mimeType === 'video/webm;codecs=vp9,opus') {
          throw new Error('encoder unavailable')
        }
        super.start()
      }
    }

    vi.stubGlobal('MediaRecorder', StartFailMediaRecorder)

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await expect(startCapture('window:1', 'meeting-1')).resolves.toBeUndefined()
    expect(recorderMimeTypes.filter((mimeType) => mimeType.startsWith('video/'))).toEqual([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus'
    ])
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })
})
