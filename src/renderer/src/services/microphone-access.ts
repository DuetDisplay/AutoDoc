import { translate, type MessageKey } from '../../../shared/i18n'

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
  return translate('en', getMicrophoneCaptureFailureMessageKey(error, isWindows))
}

export function getMicrophoneCaptureFailureMessageKey(
  error: MicrophoneAccessErrorDetails,
  isWindows: boolean
): MessageKey {
  if (!isWindows) {
    // Keep the original macOS copy: mic capture failures on macOS are
    // permission revocations surfaced via System Settings.
    return 'recording.microphoneRevoked'
  }

  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'recording.microphoneBlocked'
    case 'NotFoundError':
      return 'recording.microphoneMissing'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'recording.microphoneBusy'
    default:
      return 'recording.microphoneStartFailed'
  }
}
