import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { captureRecordingRecoveryFailure, recordPersistentDiagnosticAction } = vi.hoisted(() => ({
  captureRecordingRecoveryFailure: vi.fn(),
  recordPersistentDiagnosticAction: vi.fn()
}))

vi.mock('../renderer-sentry', () => ({
  captureRecordingRecoveryFailure
}))

vi.mock('../diagnostic-trail', () => ({
  recordPersistentDiagnosticAction
}))

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
  readonly signalLevel: number

  constructor(tracks: MockTrack[] = [], options?: { signalLevel?: number }) {
    this.tracks = tracks
    this.signalLevel = options?.signalLevel ?? 0
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

class MockAnalyser {
  fftSize = 2048
  smoothingTimeConstant = 0.2
  readonly frequencyBinCount = 32
  stream: MockMediaStream | null = null

  getByteFrequencyData(data: Uint8Array): void {
    data.fill(this.stream?.signalLevel ?? 0)
  }
}

class MockAudioContext {
  createMediaStreamSource(stream: MockMediaStream): { connect: (analyser: MockAnalyser) => void } {
    return {
      connect: (analyser: MockAnalyser) => {
        analyser.stream = stream
      }
    }
  }

  createAnalyser(): MockAnalyser {
    return new MockAnalyser()
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function createMockStreamForConstraints(
  constraints: MediaStreamConstraints | undefined
): MockMediaStream {
  if (constraints?.audio === false) {
    return new MockMediaStream([new MockTrack('video')])
  }

  if (constraints?.audio && constraints?.video) {
    return new MockMediaStream([new MockTrack('audio'), new MockTrack('video')], {
      signalLevel: 12
    })
  }

  return new MockMediaStream([new MockTrack('audio')], { signalLevel: 12 })
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
        { kind: 'audiooutput', deviceId: 'default', groupId: 'speaker-default', label: 'Speaker' }
      ]),
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        deviceChangeListeners.push(listener)
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        deviceChangeListeners = deviceChangeListeners.filter((entry) => entry !== listener)
      })
    }

    vi.stubGlobal('navigator', { mediaDevices })
    vi.stubGlobal('MediaStream', MockMediaStream)
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('AudioContext', MockAudioContext)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        send: vi.fn(),
        invoke: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(() => vi.fn())
      }
    })

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.clearAllMocks()
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

  it('does not show permission toasts during full capture recovery', async () => {
    const { startCapture, stopCapture } = await import('../recording-capture')
    const { useToastStore } = await import('../../stores/toast')
    const showToastSpy = vi.spyOn(useToastStore.getState(), 'showToast')

    useToastStore.setState({ activeToast: null })

    let getUserMediaCallCount = 0
    let initialVideoTrack: MockTrack | null = null

    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1

      if (getUserMediaCallCount <= 3) {
        const stream = createMockStreamForConstraints(constraints)
        if (constraints.audio === false) {
          initialVideoTrack = stream.getVideoTracks()[0] ?? null
        }
        return Promise.resolve(stream)
      }

      if (getUserMediaCallCount <= 6) {
        if (constraints.audio === false) {
          return Promise.resolve(new MockMediaStream([new MockTrack('video')]))
        }

        if (constraints.audio && constraints.video) {
          return Promise.resolve(new MockMediaStream([new MockTrack('video')]))
        }

        return Promise.resolve(new MockMediaStream())
      }

      return Promise.resolve(createMockStreamForConstraints(constraints))
    })

    await startCapture('window:1', 'meeting-1')
    showToastSpy.mockClear()

    initialVideoTrack?.stop()

    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.resolve()

    expect(showToastSpy).not.toHaveBeenCalled()
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'microphone_capture_failed',
        details: expect.objectContaining({ context: 'recovery' })
      })
    )

    await stopCapture()
  }, 20_000)

  it('captures a terminal recovery failure after the final retry', async () => {
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      const callNumber = getUserMediaMock.mock.calls.length + 1
      if (callNumber <= 3) {
        return Promise.resolve(createMockStreamForConstraints(constraints))
      }

      return Promise.reject(new Error('route switch failed'))
    })

    const { startCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(15_750)
    await Promise.resolve()

    expect(captureRecordingRecoveryFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        meetingId: 'meeting-1',
        sourceType: 'window',
        attemptCount: 4,
        failureKind: 'failed'
      })
    )
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_failed'
      })
    )
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
          return Promise.resolve(
            new MockMediaStream([new MockTrack('audio'), new MockTrack('video')])
          )
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

  it('recovers an ended mic track without restarting video capture', async () => {
    let initialMicStream: MockMediaStream | null = null

    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      const stream = createMockStreamForConstraints(constraints)
      if (!(constraints.audio === false) && !(constraints.audio && constraints.video)) {
        initialMicStream = stream
      }
      return Promise.resolve(stream)
    })

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    initialMicStream?.getAudioTracks()[0]?.stop()

    await vi.advanceTimersByTimeAsync(2_250)
    await Promise.resolve()

    expect(getUserMediaMock).toHaveBeenCalledTimes(4)
    expect(getUserMediaMock.mock.calls[3]?.[0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_started',
        details: expect.objectContaining({
          reason: 'mic:ended',
          expectedAudio: {
            hasMic: true,
            hasSystemAudio: true
          }
        })
      })
    )
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_recovered',
        details: expect.objectContaining({
          reason: 'mic:ended',
          segmentIndex: 1,
          expectedAudio: {
            hasMic: true,
            hasSystemAudio: true
          },
          actualAudio: {
            hasMic: true,
            hasSystemAudio: true
          }
        })
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('recovers only microphone capture for input and output route changes', async () => {
    let currentMicGroupId = 'mic-default'
    let currentSpeakerGroupId = 'speaker-default'

    const mediaDevices = navigator.mediaDevices as MediaDevices & {
      enumerateDevices: ReturnType<typeof vi.fn>
    }
    mediaDevices.enumerateDevices = vi.fn().mockImplementation(async () => [
      {
        kind: 'audioinput',
        deviceId: 'default',
        groupId: currentMicGroupId,
        label: `Mic ${currentMicGroupId}`
      },
      {
        kind: 'audiooutput',
        deviceId: 'default',
        groupId: currentSpeakerGroupId,
        label: `Speaker ${currentSpeakerGroupId}`
      }
    ])

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    currentMicGroupId = 'mic-switched'
    currentSpeakerGroupId = 'speaker-switched'
    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(750)
    await Promise.resolve()

    expect(getUserMediaMock).toHaveBeenCalledTimes(4)
    expect(getUserMediaMock.mock.calls[3]?.[0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_started',
        details: expect.objectContaining({
          reason: 'devicechange',
          audioOnly: true,
          plannedSources: ['mic']
        })
      })
    )
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_recovered',
        details: expect.objectContaining({
          reason: 'devicechange',
          segmentIndex: 1,
          actualAudio: {
            hasMic: true,
            hasSystemAudio: true
          }
        })
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('recovers microphone capture for an output-only route change', async () => {
    let currentSpeakerGroupId = 'speaker-default'

    const mediaDevices = navigator.mediaDevices as MediaDevices & {
      enumerateDevices: ReturnType<typeof vi.fn>
    }
    mediaDevices.enumerateDevices = vi.fn().mockImplementation(async () => [
      {
        kind: 'audioinput',
        deviceId: 'default',
        groupId: 'mic-default',
        label: 'Mic'
      },
      {
        kind: 'audiooutput',
        deviceId: 'default',
        groupId: currentSpeakerGroupId,
        label: `Speaker ${currentSpeakerGroupId}`
      }
    ])

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    currentSpeakerGroupId = 'speaker-switched'
    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(750)
    await Promise.resolve()

    expect(getUserMediaMock).toHaveBeenCalledTimes(4)
    expect(getUserMediaMock.mock.calls[3]?.[0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_started',
        details: expect.objectContaining({
          reason: 'devicechange',
          audioOnly: true,
          plannedSources: ['mic']
        })
      })
    )
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_recovered',
        details: expect.objectContaining({
          reason: 'devicechange',
          segmentIndex: 1
        })
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('reports degraded recovery when expected audio never returns', async () => {
    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1

      if (getUserMediaCallCount <= 3) {
        return Promise.resolve(createMockStreamForConstraints(constraints))
      }

      if (constraints.audio === false) {
        return Promise.resolve(new MockMediaStream([new MockTrack('video')]))
      }
      if (constraints.audio && constraints.video) {
        return Promise.resolve(
          new MockMediaStream([new MockTrack('audio'), new MockTrack('video')])
        )
      }
      return Promise.resolve(new MockMediaStream())
    })

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(9_750)
    await Promise.resolve()

    expect(captureRecordingRecoveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Capture recovery completed with missing audio sources: mic'
      }),
      expect.objectContaining({
        meetingId: 'meeting-1',
        sourceType: 'window',
        attemptCount: 4,
        missingSources: ['mic'],
        failureKind: 'degraded'
      })
    )
    expect(recordPersistentDiagnosticAction).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_recovered_degraded'
      })
    )
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })

  it('does not treat a silent replacement microphone as fully recovered after devicechange', async () => {
    let currentMicGroupId = 'mic-default'

    const mediaDevices = navigator.mediaDevices as MediaDevices & {
      enumerateDevices: ReturnType<typeof vi.fn>
    }
    mediaDevices.enumerateDevices = vi.fn().mockImplementation(async () => [
      {
        kind: 'audioinput',
        deviceId: 'default',
        groupId: currentMicGroupId,
        label: `Mic ${currentMicGroupId}`
      },
      {
        kind: 'audiooutput',
        deviceId: 'default',
        groupId: 'speaker-default',
        label: 'Speaker'
      }
    ])

    let getUserMediaCallCount = 0
    getUserMediaMock.mockImplementation((constraints: MediaStreamConstraints) => {
      getUserMediaCallCount += 1

      if (getUserMediaCallCount <= 3) {
        return Promise.resolve(createMockStreamForConstraints(constraints))
      }

      if (constraints.audio === false) {
        return Promise.resolve(new MockMediaStream([new MockTrack('video')]))
      }

      if (constraints.audio && constraints.video) {
        return Promise.resolve(
          new MockMediaStream([new MockTrack('audio'), new MockTrack('video')], {
            signalLevel: 12
          })
        )
      }

      return Promise.resolve(new MockMediaStream([new MockTrack('audio')], { signalLevel: 0 }))
    })

    const { startCapture, stopCapture } = await import('../recording-capture')

    await startCapture('window:1', 'meeting-1')

    currentMicGroupId = 'mic-switched'
    deviceChangeListeners.forEach((listener) => listener())

    await vi.advanceTimersByTimeAsync(750)
    await Promise.resolve()

    expect(recordPersistentDiagnosticAction).not.toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'recording',
        action: 'capture_recovery_recovered'
      })
    )

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
        if (this.mimeType === 'video/webm;codecs=vp9') {
          throw new Error('encoder unavailable')
        }
        super.start()
      }
    }

    vi.stubGlobal('MediaRecorder', StartFailMediaRecorder)

    const { isCapturing, startCapture, stopCapture } = await import('../recording-capture')

    await expect(startCapture('window:1', 'meeting-1')).resolves.toBeUndefined()
    expect(recorderMimeTypes.filter((mimeType) => mimeType.startsWith('video/'))).toEqual([
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8'
    ])
    expect(isCapturing()).toBe(true)

    await stopCapture()
  })
})
