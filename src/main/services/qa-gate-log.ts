import { logAutodocEvent } from './autodoc-log'

const QA_GATE_PREFIX = 'qa gate'

export const QA_GATE_LONG_RECORDING_SEC = 45 * 60
export const QA_GATE_GPU_STOP_TO_TRANSCRIPT_SEC = 5 * 60
export const QA_GATE_CPU_STOP_TO_TRANSCRIPT_SEC = 15 * 60
export const QA_GATE_CPU_FIRST_RUN_MAX_BYTES = 1_073_741_824
export const QA_GATE_GPU_FIRST_RUN_MAX_BYTES = 2_750_000_000

export type QaGateTier = 'gpu' | 'cpu' | 'unknown'

export function classifyWindowsTranscriptionTier(input: {
  backendId?: string | null
  device?: string | null
}): QaGateTier {
  const device = input.device ?? ''
  if (device === 'dml' || device === 'cuda') {
    return 'gpu'
  }

  const backend = input.backendId ?? ''
  if (backend === 'parakeet-gpu' || backend === 'faster-whisper-cuda') {
    return 'gpu'
  }
  if (
    backend === 'parakeet-cpu' ||
    backend === 'faster-whisper-cpu' ||
    backend === 'whisper-cpp'
  ) {
    return 'cpu'
  }

  return 'unknown'
}

export function evaluateLongMeetingStopToTranscriptGate(input: {
  recordingDurationSec: number
  stopToTranscriptWallSec: number
  tier: QaGateTier
}): { applicable: boolean; pass: boolean | null; targetWallSec: number | null } {
  if (input.recordingDurationSec < QA_GATE_LONG_RECORDING_SEC) {
    return { applicable: false, pass: null, targetWallSec: null }
  }

  const targetWallSec =
    input.tier === 'gpu'
      ? QA_GATE_GPU_STOP_TO_TRANSCRIPT_SEC
      : input.tier === 'cpu'
        ? QA_GATE_CPU_STOP_TO_TRANSCRIPT_SEC
        : null

  if (targetWallSec == null) {
    return { applicable: true, pass: null, targetWallSec: null }
  }

  return {
    applicable: true,
    pass: input.stopToTranscriptWallSec <= targetWallSec,
    targetWallSec
  }
}

export function evaluateFirstRunDownloadGate(input: {
  tier: QaGateTier
  totalDownloadedBytes: number
}): { applicable: boolean; pass: boolean | null; targetMaxBytes: number | null } {
  const targetMaxBytes =
    input.tier === 'gpu'
      ? QA_GATE_GPU_FIRST_RUN_MAX_BYTES
      : input.tier === 'cpu'
        ? QA_GATE_CPU_FIRST_RUN_MAX_BYTES
        : null

  if (targetMaxBytes == null) {
    return { applicable: true, pass: null, targetMaxBytes: null }
  }

  return {
    applicable: true,
    pass: input.totalDownloadedBytes <= targetMaxBytes,
    targetMaxBytes
  }
}

export function logQaGateFirstRunSetup(context: {
  tier: QaGateTier
  backend: string
  backendLabel: string
  modelName: string
  device: string
  computeType: string
  setupElapsedMs: number
  totalDownloadedBytes: number
  hardware: Record<string, unknown>
}): void {
  const gate = evaluateFirstRunDownloadGate({
    tier: context.tier,
    totalDownloadedBytes: context.totalDownloadedBytes
  })

  logAutodocEvent({
    area: 'whisper',
    message: `${QA_GATE_PREFIX}: first-run setup complete`,
    context: {
      ...context,
      gate: {
        name: 'first-run-download',
        applicable: gate.applicable,
        pass: gate.pass,
        targetMaxBytes: gate.targetMaxBytes,
        measuredBytes: context.totalDownloadedBytes
      }
    }
  })
}

export function logQaGateStopToTranscript(
  meetingId: string,
  context: {
    tier: QaGateTier
    backend: string
    backendLabel: string
    modelName: string
    device: string
    computeType: string
    qualityMode: string
    performanceMode: string
    dualSource: boolean
    recordingDurationSec: number
    audioDurationSec: number
    stopToTranscriptWallSec: number
    transcriptionWallSec: number
    postProcessingWallSec: number | null
    realtimeFactor: number | null
    workerReuseCount: number
    downgradesTaken: string[]
    processingProfileId: string | null
    processingProfile: Record<string, unknown> | null
  }
): void {
  const gate = evaluateLongMeetingStopToTranscriptGate({
    recordingDurationSec: context.recordingDurationSec,
    stopToTranscriptWallSec: context.stopToTranscriptWallSec,
    tier: context.tier
  })

  logAutodocEvent({
    area: 'transcription',
    message: `${QA_GATE_PREFIX}: stop-to-transcript complete`,
    meetingId,
    context: {
      ...context,
      gate: {
        name: 'long-meeting-stop-to-transcript',
        applicable: gate.applicable,
        pass: gate.pass,
        targetWallSec: gate.targetWallSec,
        measuredWallSec: context.stopToTranscriptWallSec,
        longRecordingThresholdSec: QA_GATE_LONG_RECORDING_SEC
      }
    }
  })
}

export function logQaGateStopToNotes(
  meetingId: string,
  context: {
    recordingDurationSec: number
    stopToNotesWallSec: number
    transcriptionToNotesWallSec: number
    notesItemCount: number
  }
): void {
  logAutodocEvent({
    area: 'segmentation',
    message: `${QA_GATE_PREFIX}: stop-to-notes complete`,
    meetingId,
    context
  })
}

export function logQaGateWorkerPriority(
  meetingId: string,
  context: {
    pid: number
    priorityLabel: string
    performanceMode: string
    device: string
    backend: string
  }
): void {
  logAutodocEvent({
    area: 'transcription',
    message: `${QA_GATE_PREFIX}: worker priority applied`,
    meetingId,
    context
  })
}

export function logQaGateWindowsResources(
  meetingId: string | undefined,
  phase: 'transcription-start' | 'transcription-complete' | 'notes-complete',
  context: Record<string, unknown>
): void {
  logAutodocEvent({
    area: 'transcription',
    message: `${QA_GATE_PREFIX}: windows resources snapshot`,
    meetingId,
    context: {
      phase,
      ...context
    }
  })
}

export function logQaGateWorkerLifecycle(context: {
  event: 'idle-unload' | 'idle-kill'
  pid: number | null
  idleUnloadMs: number
  idleKillMs: number
}): void {
  logAutodocEvent({
    area: 'transcription',
    message: `${QA_GATE_PREFIX}: worker lifecycle`,
    context
  })
}

export function logQaGateSettingsChanged(context: {
  setting: 'transcription-quality-mode' | 'transcription-performance-mode'
  mode: string
}): void {
  logAutodocEvent({
    area: 'app',
    message: `${QA_GATE_PREFIX}: settings changed`,
    context
  })
}

export function logQaGateFinalizingRecovery(
  meetingId: string,
  context: {
    startedAt: number
    stoppedAt: number
    recordingDurationSec: number
  }
): void {
  logAutodocEvent({
    area: 'recording',
    message: `${QA_GATE_PREFIX}: finalizing recovery started`,
    meetingId,
    context
  })
}
