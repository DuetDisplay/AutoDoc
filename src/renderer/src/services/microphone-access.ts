export interface MicrophoneAccessErrorDetails {
  name: string
  message: string
}

export interface MicrophoneProbeSuccess {
  ok: true
  stream: MediaStream
}

export interface MicrophoneProbeFailure {
  ok: false
  error: MicrophoneAccessErrorDetails
}

export type MicrophoneProbeResult = MicrophoneProbeSuccess | MicrophoneProbeFailure

export function getMicrophoneAccessErrorDetails(error: unknown): MicrophoneAccessErrorDetails {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message
    }
  }

  return {
    name: 'UnknownError',
    message: String(error)
  }
}

export async function probeMicrophoneStream(
  constraints: MediaStreamConstraints = {
    audio: { echoCancellation: true, noiseSuppression: true }
  }
): Promise<MicrophoneProbeResult> {
  try {
    return {
      ok: true,
      stream: await navigator.mediaDevices.getUserMedia(constraints)
    }
  } catch (error) {
    return {
      ok: false,
      error: getMicrophoneAccessErrorDetails(error)
    }
  }
}

export function isWindowsRenderer(): boolean {
  return typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent ?? '')
}

export function getMicrophoneCaptureFailureMessage(
  error: MicrophoneAccessErrorDetails,
  isWindows: boolean
): string {
  if (!isWindows) {
    // Keep the original macOS copy: mic capture failures on macOS are
    // permission revocations surfaced via System Settings.
    return 'Microphone access was revoked. AutoDoc needs it to record meetings. Enable it in System Settings → Privacy → Microphone.'
  }

  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Enable microphone access in Windows Settings, then try recording again.'
    case 'NotFoundError':
      return 'No microphone was detected, or Windows privacy settings are hiding it. AutoDoc can still record system audio.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your microphone is unavailable or in use by another app. AutoDoc can still record system audio.'
    default:
      return 'AutoDoc could not start the microphone. Recordings can continue with system audio only.'
  }
}
