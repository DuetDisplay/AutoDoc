import { useToastStore } from '../stores/toast'

interface CaptureHandles {
  videoRecorder: MediaRecorder
  micRecorder: MediaRecorder | null
  systemRecorder: MediaRecorder | null
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
}

let activeCapture: CaptureHandles | null = null

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
  } catch {
    audioStream = new MediaStream()
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
      const buffer = await e.data.arrayBuffer()
      window.electronAPI.invoke('recording:save-chunk', meetingId, 'video', buffer)
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
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'mic', buffer)
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
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'system', buffer)
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
  }
}

export function stopCapture(): void {
  if (!activeCapture) return

  const { videoRecorder, micRecorder, systemRecorder, videoStream, audioStream, micStream } = activeCapture

  if (videoRecorder.state !== 'inactive') videoRecorder.stop()
  if (micRecorder && micRecorder.state !== 'inactive') micRecorder.stop()
  if (systemRecorder && systemRecorder.state !== 'inactive') systemRecorder.stop()

  videoStream.getTracks().forEach((t) => t.stop())
  audioStream.getTracks().forEach((t) => t.stop())
  micStream?.getTracks().forEach((t) => t.stop())

  activeCapture = null
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
