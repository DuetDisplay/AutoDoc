import { useToastStore } from '../stores/toast'
import { recordPersistentDiagnosticAction } from './diagnostic-trail'
import { captureRecordingRecoveryFailure } from './renderer-sentry'

interface CaptureStreams {
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
}

interface DeviceSnapshot {
  defaultAudioInputKey: string | null
  defaultAudioOutputKey: string | null
}

interface AudioWatchdog {
  label: 'mic' | 'system'
  analyser: AnalyserNode
  context: AudioContext
  data: Uint8Array<ArrayBuffer>
  hasObservedSignal: boolean
  lastSignalAt: number
}

interface RecoveryValidationState {
  reason: string
  attempt: number
  expectedAudio: {
    hasMic: boolean
    hasSystemAudio: boolean
  }
  pendingSources: Array<'mic' | 'system'>
  startedAt: number
}

interface CaptureHandles {
  sourceId: string
  meetingId: string
  segmentIndex: number
  createdAt: number
  stopping: boolean
  recoverySequence: number
  expectedAudio: {
    hasMic: boolean
    hasSystemAudio: boolean
  }
  deviceSnapshot: DeviceSnapshot | null
  videoRecorder: MediaRecorder
  micRecorder: MediaRecorder | null
  systemRecorder: MediaRecorder | null
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
  micWatchdog: AudioWatchdog | null
  systemWatchdog: AudioWatchdog | null
  pendingChunkWrites: Set<Promise<void>>
  cleanupMonitoring: (() => void) | null
  recoveryTimer: ReturnType<typeof setTimeout> | null
  monitorLoopPromise: Promise<void> | null
  recoveryPromise: Promise<void> | null
  recoveryValidation: RecoveryValidationState | null
  finalizePromise: Promise<void> | null
  finalized: boolean
}

let activeCapture: CaptureHandles | null = null
const RECORDER_STOP_TIMEOUT_MS = 5_000
const RECOVERY_DEBOUNCE_MS = 750
const RECOVERY_RETRY_DELAY_MS = 1_500
const MAX_RECOVERY_ATTEMPTS = 4
const AUDIO_WATCHDOG_INTERVAL_MS = 5_000
const AUDIO_WATCHDOG_SILENCE_MS = 20_000
const AUDIO_WATCHDOG_STARTUP_GRACE_MS = 12_000
const AUDIO_SIGNAL_THRESHOLD = 4
const VIDEO_RECORDER_MIME_CANDIDATES_WITH_AUDIO = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]
const VIDEO_RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
]
const AUDIO_RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm']

async function getDefaultDeviceSnapshot(): Promise<DeviceSnapshot | null> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
    return null
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const selectKey = (kind: 'audioinput' | 'audiooutput'): string | null => {
      const candidates = devices.filter((device) => device.kind === kind)
      if (candidates.length === 0) return null
      const preferred = candidates.find((device) => device.deviceId === 'default') ?? candidates[0]
      return preferred.groupId || preferred.label || preferred.deviceId || null
    }

    return {
      defaultAudioInputKey: selectKey('audioinput'),
      defaultAudioOutputKey: selectKey('audiooutput')
    }
  } catch (err) {
    console.warn('Failed to enumerate media devices for capture watchdog:', err)
    return null
  }
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function serializeErrorForDiagnostics(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    }
  }

  return {
    name: 'UnknownError',
    message: String(error)
  }
}

function pickSupportedMimeType(candidates: string[]): string | null {
  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return candidates[0] ?? null
  }

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null
}

function buildRecorderError(
  err: unknown,
  label: 'video' | 'mic' | 'system',
  mimeType: string | null,
  action: 'create' | 'start'
): Error {
  return new Error(
    `Failed to ${action} ${label} recorder${mimeType ? ` (${mimeType})` : ''}: ${describeError(err)}`
  )
}

function createRecorder(
  stream: MediaStream,
  label: 'video' | 'mic' | 'system',
  mimeType: string | null,
  options: Omit<MediaRecorderOptions, 'mimeType'> = {}
): MediaRecorder {
  if (stream.getTracks().every((track) => track.readyState !== 'live')) {
    throw new Error(`Cannot create ${label} recorder because its capture stream is not live`)
  }

  const recorderOptions = mimeType ? { ...options, mimeType } : { ...options }

  try {
    return new MediaRecorder(stream, recorderOptions)
  } catch (err) {
    throw buildRecorderError(err, label, mimeType, 'create')
  }
}

function createStartedRecorder(
  stream: MediaStream,
  label: 'video' | 'mic' | 'system',
  mimeCandidates: string[],
  options: Omit<MediaRecorderOptions, 'mimeType'>,
  onDataAvailable: ((event: { data: Blob }) => void) | null
): MediaRecorder {
  const attemptedMimeTypes = new Set<string | null>()
  const candidateMimeTypes: Array<string | null> = mimeCandidates.filter((candidate) => {
    if (attemptedMimeTypes.has(candidate)) {
      return false
    }
    attemptedMimeTypes.add(candidate)
    return pickSupportedMimeType([candidate]) === candidate
  })

  if (candidateMimeTypes.length === 0) {
    candidateMimeTypes.push(null)
  }

  let lastError: Error | null = null

  for (const candidateMimeType of candidateMimeTypes) {
    const mimeType = candidateMimeType || null
    let recorder: MediaRecorder
    try {
      recorder = createRecorder(stream, label, mimeType, options)
    } catch (err) {
      lastError = err instanceof Error ? err : buildRecorderError(err, label, mimeType, 'create')
      continue
    }

    recorder.ondataavailable = onDataAvailable

    try {
      recorder.start(5000)
      return recorder
    } catch (err) {
      lastError = buildRecorderError(err, label, mimeType, 'start')
    }
  }

  throw lastError ?? new Error(`Failed to start ${label} recorder`)
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop())
}

function streamHasLiveAudio(stream: MediaStream | null): boolean {
  return Boolean(stream?.getAudioTracks().some((track) => track.readyState === 'live'))
}

function getCaptureAudioAvailability(capture: Pick<CaptureHandles, 'audioStream' | 'micStream'>): {
  hasMic: boolean
  hasSystemAudio: boolean
} {
  return {
    hasMic: streamHasLiveAudio(capture.micStream),
    hasSystemAudio: streamHasLiveAudio(capture.audioStream)
  }
}

function getMissingRecoverySources(
  expected: { hasMic: boolean; hasSystemAudio: boolean },
  actual: { hasMic: boolean; hasSystemAudio: boolean }
): Array<'mic' | 'system'> {
  const missing: Array<'mic' | 'system'> = []

  if (expected.hasMic && !actual.hasMic) {
    missing.push('mic')
  }
  if (expected.hasSystemAudio && !actual.hasSystemAudio) {
    missing.push('system')
  }

  return missing
}

function getSourceType(sourceId: string): string {
  return sourceId.split(':', 1)[0] ?? 'unknown'
}

function didDefaultRouteChange(
  previousKey: string | null | undefined,
  nextKey: string | null | undefined
): boolean {
  return Boolean(previousKey) && Boolean(nextKey) && previousKey !== nextKey
}

function recordCaptureRecoveryDiagnostic(
  action:
    | 'capture_recovery_started'
    | 'capture_recovery_attempt_failed'
    | 'capture_recovery_waiting_for_routes'
    | 'capture_recovery_failed'
    | 'capture_recovery_recovered'
    | 'capture_recovery_recovered_degraded',
  details: Record<string, unknown>
): void {
  recordPersistentDiagnosticAction({
    category: 'recording',
    action,
    details
  })
}

function createAudioWatchdog(
  stream: MediaStream | null,
  label: 'mic' | 'system'
): AudioWatchdog | null {
  if (!stream || stream.getAudioTracks().length === 0) {
    return null
  }

  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor) {
    return null
  }

  try {
    const context = new AudioContextCtor()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.2
    source.connect(analyser)
    void context.resume().catch(() => {})

    return {
      label,
      analyser,
      context,
      data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
      hasObservedSignal: false,
      lastSignalAt: Date.now()
    }
  } catch (err) {
    console.warn(`Failed to create ${label} audio watchdog:`, err)
    return null
  }
}

function sampleAudioWatchdog(watchdog: AudioWatchdog): void {
  watchdog.analyser.getByteFrequencyData(watchdog.data)
  let max = 0
  for (const value of watchdog.data) {
    if (value > max) {
      max = value
    }
  }

  if (max >= AUDIO_SIGNAL_THRESHOLD) {
    watchdog.hasObservedSignal = true
    watchdog.lastSignalAt = Date.now()
  }
}

async function closeAudioWatchdog(watchdog: AudioWatchdog | null): Promise<void> {
  if (!watchdog) return
  try {
    await watchdog.context.close()
  } catch {
    // Ignore audio context close failures during teardown.
  }
}

function getPendingRecoveryValidationSources(
  reason: string,
  previousSnapshot: DeviceSnapshot | null,
  nextSnapshot: DeviceSnapshot | null,
  expectedAudio: { hasMic: boolean; hasSystemAudio: boolean },
  actualAudio: { hasMic: boolean; hasSystemAudio: boolean },
  capture: Pick<CaptureHandles, 'micWatchdog' | 'systemWatchdog'>
): Array<'mic' | 'system'> {
  const pendingSources: Array<'mic' | 'system'> = []
  const inputRouteChanged = didDefaultRouteChange(
    previousSnapshot?.defaultAudioInputKey,
    nextSnapshot?.defaultAudioInputKey
  )
  const outputRouteChanged = didDefaultRouteChange(
    previousSnapshot?.defaultAudioOutputKey,
    nextSnapshot?.defaultAudioOutputKey
  )

  if (
    (reason === 'devicechange' || reason.startsWith('watchdog:mic') || reason.startsWith('mic:')) &&
    inputRouteChanged &&
    expectedAudio.hasMic &&
    actualAudio.hasMic &&
    capture.micWatchdog
  ) {
    sampleAudioWatchdog(capture.micWatchdog)
    if (!capture.micWatchdog.hasObservedSignal) {
      pendingSources.push('mic')
    }
  }

  if (
    reason.startsWith('watchdog:output') &&
    outputRouteChanged &&
    expectedAudio.hasSystemAudio &&
    actualAudio.hasSystemAudio &&
    capture.systemWatchdog
  ) {
    sampleAudioWatchdog(capture.systemWatchdog)
    if (!capture.systemWatchdog.hasObservedSignal) {
      pendingSources.push('system')
    }
  }

  return pendingSources
}

function trackChunkWrite(
  pendingChunkWrites: Set<Promise<void>>,
  meetingId: string,
  type: 'video' | 'mic' | 'system',
  segmentIndex: number,
  data: Blob
): void {
  const savePromise: Promise<void> = (async () => {
    const buffer = await data.arrayBuffer()
    await window.electronAPI.invoke('recording:save-chunk', meetingId, type, buffer, segmentIndex)
  })()
    .catch((err) => {
      console.error(`Failed to persist ${type} recording chunk:`, err)
    })
    .finally(() => {
      pendingChunkWrites.delete(savePromise)
    })

  pendingChunkWrites.add(savePromise)
}

function waitForRecorderStop(recorder: MediaRecorder | null, label: string): Promise<void> {
  if (!recorder || recorder.state === 'inactive') {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const finalize = (): void => {
      if (settled) return
      settled = true
      recorder.removeEventListener('stop', handleStop)
      recorder.removeEventListener('error', handleError)
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      resolve()
    }

    const handleStop = (): void => finalize()
    const handleError = (event: Event): void => {
      console.error(`Recorder ${label} stopped with an error event:`, event)
      finalize()
    }

    timeoutId = setTimeout(() => {
      console.error(`Timed out waiting for ${label} recorder to stop`)
      finalize()
    }, RECORDER_STOP_TIMEOUT_MS)

    recorder.addEventListener('stop', handleStop, { once: true })
    recorder.addEventListener('error', handleError, { once: true })

    try {
      recorder.requestData()
    } catch {
      // Ignore requestData failures during shutdown.
    }

    try {
      recorder.stop()
    } catch (err) {
      console.error(`Failed to stop ${label} recorder cleanly:`, err)
      finalize()
    }
  })
}

async function waitForPendingChunkWrites(pendingChunkWrites: Set<Promise<void>>): Promise<void> {
  while (pendingChunkWrites.size > 0) {
    await Promise.allSettled([...pendingChunkWrites])
  }
}

async function createCaptureStreams(sourceId: string): Promise<CaptureStreams> {
  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30
      }
    } as MediaTrackConstraints
  })

  // Check screen recording permission — use the actual video track state
  // rather than the thumbnail heuristic which can false-positive
  const videoTrack = videoStream.getVideoTracks()[0]
  if (!videoTrack || videoTrack.readyState !== 'live') {
    useToastStore.getState().showToast({
      type: 'screen',
      message:
        'Screen recording lets AutoDoc capture meeting visuals. Enable it in System Settings → Privacy → Screen Recording.',
      action: {
        label: 'Enable',
        type: 'open-settings',
        target: 'screen'
      }
    })
    stopStream(videoStream)
    throw new Error(
      'Screen capture stream is not live. Screen recording permission may be missing.'
    )
  }

  let audioStream: MediaStream
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      } as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 1
        }
      } as MediaTrackConstraints
    })
    audioStream.getVideoTracks().forEach((t) => t.stop())
  } catch (err) {
    console.error('System audio capture failed:', err)
    audioStream = new MediaStream()
    useToastStore.getState().showToast({
      type: 'screen',
      message:
        'System audio capture failed. AutoDoc can still record, but speaker labeling may be unavailable for this recording.'
    })
  }

  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
  } catch {
    // Mic may not be available
  }

  if (!micStream || micStream.getAudioTracks().length === 0) {
    useToastStore.getState().showToast({
      type: 'microphone',
      message:
        'Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone.',
      action: {
        label: 'Enable',
        type: 'open-settings',
        target: 'microphone'
      }
    })
  }

  return {
    videoStream,
    audioStream,
    micStream
  }
}

function queueCaptureRecovery(capture: CaptureHandles, reason: string): void {
  if (
    activeCapture !== capture ||
    capture.stopping ||
    capture.finalized ||
    capture.finalizePromise ||
    capture.recoveryPromise
  ) {
    return
  }

  if (capture.recoveryTimer) {
    return
  }

  capture.recoveryTimer = setTimeout(() => {
    capture.recoveryTimer = null
    void recoverCapture(capture, reason)
  }, RECOVERY_DEBOUNCE_MS)
}

function installCaptureMonitoring(capture: CaptureHandles): void {
  const cleanupFns: Array<() => void> = []
  const micWatchdog = createAudioWatchdog(capture.micStream, 'mic')
  const systemWatchdog = createAudioWatchdog(capture.audioStream, 'system')
  capture.micWatchdog = micWatchdog
  capture.systemWatchdog = systemWatchdog
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const onDeviceChange = (): void => {
    queueCaptureRecovery(capture, 'devicechange')
  }

  if (typeof navigator.mediaDevices?.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    cleanupFns.push(() =>
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
    )
  }

  const watchTrack = (
    track: MediaStreamTrack,
    label: string,
    events: Array<'ended' | 'mute'>
  ): void => {
    for (const eventName of events) {
      const handler = (): void => queueCaptureRecovery(capture, `${label}:${eventName}`)
      track.addEventListener(eventName, handler)
      cleanupFns.push(() => track.removeEventListener(eventName, handler))
    }
  }

  capture.videoStream.getTracks().forEach((track) => watchTrack(track, 'video', ['ended']))
  capture.audioStream.getTracks().forEach((track) => watchTrack(track, 'system', ['ended', 'mute']))
  capture.micStream?.getTracks().forEach((track) => watchTrack(track, 'mic', ['ended', 'mute']))

  const evaluateAudioWatchdog = async (): Promise<void> => {
    if (closed || activeCapture !== capture || capture.finalized) {
      return
    }

    micWatchdog && sampleAudioWatchdog(micWatchdog)
    systemWatchdog && sampleAudioWatchdog(systemWatchdog)

    if (capture.recoveryValidation) {
      const pendingSources = capture.recoveryValidation.pendingSources.filter((source) => {
        if (source === 'mic') {
          return !micWatchdog?.hasObservedSignal
        }
        return !systemWatchdog?.hasObservedSignal
      })

      if (pendingSources.length === 0) {
        const completedValidation = capture.recoveryValidation
        capture.recoveryValidation = null
        recordCaptureRecoveryDiagnostic('capture_recovery_recovered', {
          meetingId: capture.meetingId,
          sourceType: getSourceType(capture.sourceId),
          segmentIndex: capture.segmentIndex,
          reason: completedValidation.reason,
          attempt: completedValidation.attempt,
          expectedAudio: completedValidation.expectedAudio,
          actualAudio: getCaptureAudioAvailability(capture)
        })
        return
      }

      capture.recoveryValidation.pendingSources = pendingSources

      if (
        Date.now() - capture.recoveryValidation.startedAt >= AUDIO_WATCHDOG_STARTUP_GRACE_MS &&
        activeCapture === capture &&
        !capture.stopping
      ) {
        const completedValidation = capture.recoveryValidation
        capture.recoveryValidation = null

        if (capture.recoverySequence < MAX_RECOVERY_ATTEMPTS) {
          console.warn('Recovered capture remained silent after route change, retrying', {
            meetingId: capture.meetingId,
            reason: completedValidation.reason,
            pendingSources
          })
          queueCaptureRecovery(
            capture,
            pendingSources.includes('mic')
              ? 'watchdog:mic-route-changed'
              : 'watchdog:output-route-changed'
          )
          return
        }

        const degradationError = new Error(
          `Capture recovery completed with missing audio signal: ${pendingSources.join(', ')}`
        )
        const actualAudio = getCaptureAudioAvailability(capture)
        recordCaptureRecoveryDiagnostic('capture_recovery_recovered_degraded', {
          meetingId: capture.meetingId,
          sourceType: getSourceType(capture.sourceId),
          segmentIndex: capture.segmentIndex,
          reason: completedValidation.reason,
          attempt: completedValidation.attempt,
          expectedAudio: completedValidation.expectedAudio,
          actualAudio,
          missingSources: pendingSources
        })
        captureRecordingRecoveryFailure(degradationError, {
          meetingId: capture.meetingId,
          sourceType: getSourceType(capture.sourceId),
          segmentIndex: capture.segmentIndex,
          reason: completedValidation.reason,
          attemptCount: capture.recoverySequence,
          expectedAudio: completedValidation.expectedAudio,
          actualAudio,
          missingSources: pendingSources,
          failureKind: 'degraded'
        })
        return
      }
    }

    if (!micWatchdog && !systemWatchdog) {
      return
    }

    const snapshot = await getDefaultDeviceSnapshot()
    if (!snapshot || !capture.deviceSnapshot) {
      return
    }

    const now = Date.now()
    const micRouteChanged =
      Boolean(capture.deviceSnapshot.defaultAudioInputKey) &&
      Boolean(snapshot.defaultAudioInputKey) &&
      capture.deviceSnapshot.defaultAudioInputKey !== snapshot.defaultAudioInputKey
    const outputRouteChanged =
      Boolean(capture.deviceSnapshot.defaultAudioOutputKey) &&
      Boolean(snapshot.defaultAudioOutputKey) &&
      capture.deviceSnapshot.defaultAudioOutputKey !== snapshot.defaultAudioOutputKey

    const micLooksDead = Boolean(
      micWatchdog &&
      micRouteChanged &&
      ((micWatchdog.hasObservedSignal &&
        now - micWatchdog.lastSignalAt >= AUDIO_WATCHDOG_SILENCE_MS) ||
        (!micWatchdog.hasObservedSignal &&
          now - capture.createdAt >= AUDIO_WATCHDOG_STARTUP_GRACE_MS))
    )
    const systemLooksDead = Boolean(
      systemWatchdog &&
      outputRouteChanged &&
      ((systemWatchdog.hasObservedSignal &&
        now - systemWatchdog.lastSignalAt >= AUDIO_WATCHDOG_SILENCE_MS) ||
        (!systemWatchdog.hasObservedSignal &&
          now - capture.createdAt >= AUDIO_WATCHDOG_STARTUP_GRACE_MS))
    )

    if (micLooksDead) {
      queueCaptureRecovery(capture, 'watchdog:mic-route-changed')
      return
    }

    if (systemLooksDead) {
      queueCaptureRecovery(capture, 'watchdog:output-route-changed')
    }
  }

  watchdogTimer = setInterval(() => {
    if (capture.monitorLoopPromise) {
      return
    }

    capture.monitorLoopPromise = evaluateAudioWatchdog()
      .catch((err) => {
        console.warn('Audio watchdog failed during recording:', err)
      })
      .finally(() => {
        capture.monitorLoopPromise = null
      })
  }, AUDIO_WATCHDOG_INTERVAL_MS)

  capture.cleanupMonitoring = () => {
    closed = true
    if (capture.recoveryTimer) {
      clearTimeout(capture.recoveryTimer)
      capture.recoveryTimer = null
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    for (const cleanup of cleanupFns) {
      cleanup()
    }
    capture.micWatchdog = null
    capture.systemWatchdog = null
    capture.recoveryValidation = null
    void closeAudioWatchdog(micWatchdog)
    void closeAudioWatchdog(systemWatchdog)
  }
}

function buildCaptureHandles(
  sourceId: string,
  meetingId: string,
  segmentIndex: number,
  recoverySequence: number,
  expectedAudio: { hasMic: boolean; hasSystemAudio: boolean } | null,
  deviceSnapshot: DeviceSnapshot | null,
  streams: CaptureStreams
): CaptureHandles {
  const { videoStream, audioStream, micStream } = streams
  const hasSystemAudio = audioStream.getAudioTracks().length > 0
  const hasMic = micStream !== null && micStream.getAudioTracks().length > 0
  const pendingChunkWrites = new Set<Promise<void>>()

  const videoWithAudio = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...(hasSystemAudio ? audioStream.getAudioTracks() : [])
  ])
  const videoRecorder = createStartedRecorder(
    videoWithAudio,
    'video',
    hasSystemAudio ? VIDEO_RECORDER_MIME_CANDIDATES_WITH_AUDIO : VIDEO_RECORDER_MIME_CANDIDATES,
    {
      videoBitsPerSecond: 1_500_000
    },
    async (e) => {
      if (e.data.size > 0) {
        trackChunkWrite(pendingChunkWrites, meetingId, 'video', segmentIndex, e.data)
      }
    }
  )

  let micRecorder: MediaRecorder | null = null
  if (hasMic) {
    micRecorder = createStartedRecorder(
      micStream!,
      'mic',
      AUDIO_RECORDER_MIME_CANDIDATES,
      {},
      async (e) => {
        if (e.data.size > 0) {
          trackChunkWrite(pendingChunkWrites, meetingId, 'mic', segmentIndex, e.data)
        }
      }
    )
  }

  let systemRecorder: MediaRecorder | null = null
  if (hasSystemAudio) {
    systemRecorder = createStartedRecorder(
      audioStream,
      'system',
      AUDIO_RECORDER_MIME_CANDIDATES,
      {},
      async (e) => {
        if (e.data.size > 0) {
          trackChunkWrite(pendingChunkWrites, meetingId, 'system', segmentIndex, e.data)
        }
      }
    )
  }

  return {
    sourceId,
    meetingId,
    segmentIndex,
    createdAt: Date.now(),
    stopping: false,
    recoverySequence,
    expectedAudio: expectedAudio ?? { hasMic, hasSystemAudio },
    deviceSnapshot,
    videoRecorder,
    micRecorder,
    systemRecorder,
    videoStream,
    audioStream,
    micStream,
    micWatchdog: null,
    systemWatchdog: null,
    pendingChunkWrites,
    cleanupMonitoring: null,
    recoveryTimer: null,
    monitorLoopPromise: null,
    recoveryPromise: null,
    recoveryValidation: null,
    finalizePromise: null,
    finalized: false
  }
}

async function createCaptureSegment(
  sourceId: string,
  meetingId: string,
  segmentIndex: number,
  recoverySequence = 0,
  expectedAudio: { hasMic: boolean; hasSystemAudio: boolean } | null = null
): Promise<CaptureHandles> {
  const streams = await createCaptureStreams(sourceId)

  try {
    const deviceSnapshot = await getDefaultDeviceSnapshot()
    const capture = buildCaptureHandles(
      sourceId,
      meetingId,
      segmentIndex,
      recoverySequence,
      expectedAudio,
      deviceSnapshot,
      streams
    )

    installCaptureMonitoring(capture)

    return capture
  } catch (err) {
    stopStream(streams.videoStream)
    stopStream(streams.audioStream)
    streams.micStream && stopStream(streams.micStream)
    throw err
  }
}

function finalizeCapture(capture: CaptureHandles): Promise<void> {
  if (capture.finalizePromise) {
    return capture.finalizePromise
  }

  capture.finalizePromise = (async () => {
    capture.cleanupMonitoring?.()
    capture.cleanupMonitoring = null

    try {
      await Promise.all([
        waitForRecorderStop(capture.videoRecorder, 'video'),
        waitForRecorderStop(capture.micRecorder, 'mic'),
        waitForRecorderStop(capture.systemRecorder, 'system')
      ])
      await waitForPendingChunkWrites(capture.pendingChunkWrites)
    } finally {
      capture.videoStream.getTracks().forEach((t) => t.stop())
      capture.audioStream.getTracks().forEach((t) => t.stop())
      capture.micStream?.getTracks().forEach((t) => t.stop())
      capture.finalized = true
    }
  })()

  return capture.finalizePromise
}

async function recoverCapture(capture: CaptureHandles, reason: string): Promise<void> {
  if (activeCapture !== capture || capture.stopping || capture.finalized) {
    return
  }

  if (capture.recoveryPromise) {
    return capture.recoveryPromise
  }

  capture.recoveryPromise = (async () => {
    console.warn(`Capture source changed during recording, attempting recovery (${reason})`)
    const expectedAudio = capture.expectedAudio
    recordCaptureRecoveryDiagnostic('capture_recovery_started', {
      meetingId: capture.meetingId,
      sourceType: getSourceType(capture.sourceId),
      segmentIndex: capture.segmentIndex,
      reason,
      expectedAudio
    })
    await finalizeCapture(capture)

    if (activeCapture !== capture || capture.stopping) {
      return
    }

    try {
      for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
        if (activeCapture !== capture || capture.stopping) {
          return
        }

        let replacement: CaptureHandles | null = null
        try {
          replacement = await createCaptureSegment(
            capture.sourceId,
            capture.meetingId,
            capture.segmentIndex + 1,
            capture.recoverySequence + 1,
            expectedAudio
          )
          const actualAudio = getCaptureAudioAvailability(replacement)
          const missingSources = getMissingRecoverySources(expectedAudio, actualAudio)

          if (missingSources.length > 0 && attempt < MAX_RECOVERY_ATTEMPTS) {
            recordCaptureRecoveryDiagnostic('capture_recovery_waiting_for_routes', {
              meetingId: capture.meetingId,
              sourceType: getSourceType(capture.sourceId),
              segmentIndex: replacement.segmentIndex,
              reason,
              attempt,
              expectedAudio,
              actualAudio,
              missingSources
            })
            console.warn('Capture recovery is waiting for audio routes to settle', {
              meetingId: capture.meetingId,
              attempt,
              reason,
              missingSources,
              expectedAudio,
              actualAudio
            })
            await finalizeCapture(replacement)
            await delay(RECOVERY_RETRY_DELAY_MS * attempt)
            continue
          }

          if (activeCapture !== capture || capture.stopping) {
            await finalizeCapture(replacement)
            return
          }

          if (missingSources.length > 0) {
            const degradationError = new Error(
              `Capture recovery completed with missing audio sources: ${missingSources.join(', ')}`
            )
            recordCaptureRecoveryDiagnostic('capture_recovery_recovered_degraded', {
              meetingId: capture.meetingId,
              sourceType: getSourceType(capture.sourceId),
              segmentIndex: replacement.segmentIndex,
              reason,
              attempt,
              expectedAudio,
              actualAudio,
              missingSources
            })
            captureRecordingRecoveryFailure(degradationError, {
              meetingId: capture.meetingId,
              sourceType: getSourceType(capture.sourceId),
              segmentIndex: replacement.segmentIndex,
              reason,
              attemptCount: attempt,
              expectedAudio,
              actualAudio,
              missingSources,
              failureKind: 'degraded'
            })
          } else {
            const pendingValidationSources = getPendingRecoveryValidationSources(
              reason,
              capture.deviceSnapshot,
              replacement.deviceSnapshot,
              expectedAudio,
              actualAudio,
              replacement
            )

            if (pendingValidationSources.length > 0) {
              replacement.recoveryValidation = {
                reason,
                attempt,
                expectedAudio,
                pendingSources: pendingValidationSources,
                startedAt: Date.now()
              }
            } else {
              recordCaptureRecoveryDiagnostic('capture_recovery_recovered', {
                meetingId: capture.meetingId,
                sourceType: getSourceType(capture.sourceId),
                segmentIndex: replacement.segmentIndex,
                reason,
                attempt,
                expectedAudio,
                actualAudio
              })
            }
          }

          activeCapture = replacement
          console.log(
            replacement.recoveryValidation
              ? 'Capture resumed after device change; awaiting audio signal validation'
              : 'Capture recovered after device change',
            {
            meetingId: capture.meetingId,
            nextSegmentIndex: replacement.segmentIndex,
            reason,
            attempt,
            missingSources
            }
          )
          return
        } catch (err) {
          const canRetry =
            attempt < MAX_RECOVERY_ATTEMPTS && activeCapture === capture && !capture.stopping

          if (!canRetry) {
            recordCaptureRecoveryDiagnostic('capture_recovery_failed', {
              meetingId: capture.meetingId,
              sourceType: getSourceType(capture.sourceId),
              segmentIndex: capture.segmentIndex,
              reason,
              attempt,
              expectedAudio,
              error: serializeErrorForDiagnostics(err)
            })
            captureRecordingRecoveryFailure(err, {
              meetingId: capture.meetingId,
              sourceType: getSourceType(capture.sourceId),
              segmentIndex: capture.segmentIndex,
              reason,
              attemptCount: attempt,
              expectedAudio,
              failureKind: 'failed'
            })
            console.error('Failed to recover capture after device change:', err)
            return
          }

          recordCaptureRecoveryDiagnostic('capture_recovery_attempt_failed', {
            meetingId: capture.meetingId,
            sourceType: getSourceType(capture.sourceId),
            segmentIndex: capture.segmentIndex,
            reason,
            attempt,
            expectedAudio,
            error: serializeErrorForDiagnostics(err)
          })
          console.warn('Capture recovery attempt failed, retrying', {
            meetingId: capture.meetingId,
            attempt,
            reason,
            error: describeError(err)
          })
          await delay(RECOVERY_RETRY_DELAY_MS * attempt)
        }
      }
    } finally {
      capture.recoveryPromise = null
    }
  })()

  return capture.recoveryPromise
}

export async function startCapture(sourceId: string, meetingId: string): Promise<void> {
  if (activeCapture) {
    throw new Error('Capture already active')
  }

  activeCapture = await createCaptureSegment(sourceId, meetingId, 0)
}

export async function stopCapture(): Promise<void> {
  if (!activeCapture) return

  const capture = activeCapture
  capture.stopping = true
  activeCapture = null

  await capture.recoveryPromise?.catch(() => {})
  await finalizeCapture(capture)
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
