import { useToastStore } from '../stores/toast'

interface CaptureHandles {
  videoRecorder: MediaRecorder
  micRecorder: MediaRecorder | null
  systemRecorder: MediaRecorder | null
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
  pendingChunkWrites: Set<Promise<void>>
}

let activeCapture: CaptureHandles | null = null
const RECORDER_STOP_TIMEOUT_MS = 5_000

function trackChunkWrite(
  pendingChunkWrites: Set<Promise<void>>,
  meetingId: string,
  type: 'video' | 'mic' | 'system',
  data: Blob,
): void {
  let savePromise: Promise<void>
  savePromise = (async () => {
    const buffer = await data.arrayBuffer()
    await window.electronAPI.invoke('recording:save-chunk', meetingId, type, buffer)
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

    const finalize = () => {
      if (settled) return
      settled = true
      recorder.removeEventListener('stop', handleStop)
      recorder.removeEventListener('error', handleError)
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      resolve()
    }

    const handleStop = () => finalize()
    const handleError = (event: Event) => {
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

export async function startCapture(
  sourceId: string,
  meetingId: string,
): Promise<void> {
  if (activeCapture) {
    throw new Error('Capture already active')
  }

  // 1. Capture window video (no audio)
  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
      },
    } as MediaTrackConstraints,
  })

  // Check screen recording permission — use the actual video track state
  // rather than the thumbnail heuristic which can false-positive
  const videoTrack = videoStream.getVideoTracks()[0]
  if (!videoTrack || videoTrack.readyState !== 'live') {
    useToastStore.getState().showToast({
      type: 'screen',
      message: 'Screen recording lets AutoDoc capture meeting visuals. Enable it in System Settings → Privacy → Screen Recording.',
    })
  }

  // 2. Capture system audio (entire desktop audio)
  let audioStream: MediaStream
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
        },
      } as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          maxFrameRate: 1,
        },
      } as MediaTrackConstraints,
    })
    audioStream.getVideoTracks().forEach((t) => t.stop())
  } catch (err) {
    console.error('System audio capture failed:', err)
    audioStream = new MediaStream()
    useToastStore.getState().showToast({
      type: 'microphone',
      message: 'System audio capture failed. Speaker diarization will be unavailable for this recording.',
    })
  }

  // 3. Capture microphone
  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    // Mic may not be available
  }

  if (!micStream || micStream.getAudioTracks().length === 0) {
    useToastStore.getState().showToast({
      type: 'microphone',
      message: 'Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone.',
    })
  }

  const hasSystemAudio = audioStream.getAudioTracks().length > 0
  const hasMic = micStream !== null && micStream.getAudioTracks().length > 0
  const pendingChunkWrites = new Set<Promise<void>>()

  // 4. Set up video recorder (mux system audio into video for clean playback)
  const videoWithAudio = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...(hasSystemAudio ? audioStream.getAudioTracks() : []),
  ])
  const videoRecorder = new MediaRecorder(videoWithAudio, {
    mimeType: hasSystemAudio ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9',
    videoBitsPerSecond: 1_500_000,
  })

  videoRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      trackChunkWrite(pendingChunkWrites, meetingId, 'video', e.data)
    }
  }

  // 5. Set up mic recorder (separate stream)
  let micRecorder: MediaRecorder | null = null
  if (hasMic) {
    micRecorder = new MediaRecorder(micStream!, {
      mimeType: 'audio/webm;codecs=opus',
    })
    micRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        trackChunkWrite(pendingChunkWrites, meetingId, 'mic', e.data)
      }
    }
  }

  // 6. Set up system audio recorder (separate stream)
  let systemRecorder: MediaRecorder | null = null
  if (hasSystemAudio) {
    systemRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus',
    })
    systemRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        trackChunkWrite(pendingChunkWrites, meetingId, 'system', e.data)
      }
    }
  }

  // 7. Start all recorders
  videoRecorder.start(5000)
  micRecorder?.start(5000)
  systemRecorder?.start(5000)

  activeCapture = {
    videoRecorder,
    micRecorder,
    systemRecorder,
    videoStream,
    audioStream,
    micStream,
    pendingChunkWrites,
  }
}

export async function stopCapture(): Promise<void> {
  if (!activeCapture) return

  const { videoRecorder, micRecorder, systemRecorder, videoStream, audioStream, micStream, pendingChunkWrites } = activeCapture
  activeCapture = null

  try {
    await Promise.all([
      waitForRecorderStop(videoRecorder, 'video'),
      waitForRecorderStop(micRecorder, 'mic'),
      waitForRecorderStop(systemRecorder, 'system'),
    ])
    await waitForPendingChunkWrites(pendingChunkWrites)
  } finally {
    videoStream.getTracks().forEach((t) => t.stop())
    audioStream.getTracks().forEach((t) => t.stop())
    micStream?.getTracks().forEach((t) => t.stop())
  }
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
