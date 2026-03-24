interface CaptureHandles {
  videoRecorder: MediaRecorder
  audioRecorder: MediaRecorder
  videoStream: MediaStream
  audioStream: MediaStream
  micStream: MediaStream | null
  audioContext: AudioContext | null
}

let activeCapture: CaptureHandles | null = null

export async function startCapture(
  sourceId: string,
  meetingId: string,
): Promise<void> {
  if (activeCapture) {
    throw new Error('Capture already active')
  }

  // 1. Capture window video (no audio — desktopCapturer can't get per-window audio)
  const videoStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 15,
      },
    } as MediaTrackConstraints,
  })

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
    // Remove the video track — we only want audio from this stream
    audioStream.getVideoTracks().forEach((t) => t.stop())
  } catch {
    // System audio may not be available (especially macOS without loopback)
    audioStream = new MediaStream()
  }

  // 3. Capture microphone
  let micStream: MediaStream | null = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    // Mic may not be available — continue without it
  }

  // 4. Mix audio streams via AudioContext
  let mixedAudioStream: MediaStream
  let audioContext: AudioContext | null = null

  const hasSystemAudio = audioStream.getAudioTracks().length > 0
  const hasMic = micStream !== null && micStream.getAudioTracks().length > 0

  if (hasSystemAudio && hasMic) {
    audioContext = new AudioContext({ sampleRate: 16000 })
    const destination = audioContext.createMediaStreamDestination()

    const systemSource = audioContext.createMediaStreamSource(audioStream)
    systemSource.connect(destination)

    const micSource = audioContext.createMediaStreamSource(micStream!)
    micSource.connect(destination)

    mixedAudioStream = destination.stream
  } else if (hasSystemAudio) {
    mixedAudioStream = audioStream
  } else if (hasMic) {
    mixedAudioStream = micStream!
  } else {
    mixedAudioStream = new MediaStream()
  }

  // 5. Set up video recorder (WebM)
  const videoRecorder = new MediaRecorder(videoStream, {
    mimeType: 'video/webm;codecs=vp9',
    videoBitsPerSecond: 1_500_000,
  })

  videoRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      const buffer = await e.data.arrayBuffer()
      window.electronAPI.invoke('recording:save-chunk', meetingId, 'video', buffer)
    }
  }

  // 6. Set up audio recorder (WebM/Opus — converted to WAV in transcription sub-project)
  let audioRecorder: MediaRecorder
  if (mixedAudioStream.getAudioTracks().length > 0) {
    audioRecorder = new MediaRecorder(mixedAudioStream, {
      mimeType: 'audio/webm;codecs=opus',
    })
    audioRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        const buffer = await e.data.arrayBuffer()
        window.electronAPI.invoke('recording:save-chunk', meetingId, 'audio', buffer)
      }
    }
  } else {
    audioRecorder = new MediaRecorder(new MediaStream())
  }

  // 7. Start recording — chunk every 5 seconds
  videoRecorder.start(5000)
  if (mixedAudioStream.getAudioTracks().length > 0) {
    audioRecorder.start(5000)
  }

  activeCapture = {
    videoRecorder,
    audioRecorder,
    videoStream,
    audioStream,
    micStream,
    audioContext,
  }
}

export function stopCapture(): void {
  if (!activeCapture) return

  const { videoRecorder, audioRecorder, videoStream, audioStream, micStream, audioContext } = activeCapture

  if (videoRecorder.state !== 'inactive') videoRecorder.stop()
  if (audioRecorder.state !== 'inactive') audioRecorder.stop()

  videoStream.getTracks().forEach((t) => t.stop())
  audioStream.getTracks().forEach((t) => t.stop())
  micStream?.getTracks().forEach((t) => t.stop())

  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close()
  }

  activeCapture = null
}

export function isCapturing(): boolean {
  return activeCapture !== null
}
