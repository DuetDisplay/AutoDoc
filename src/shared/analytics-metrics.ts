export type RamBucket = '8gb' | '16gb' | '32gb+'
export type CpuClass = 'low' | 'recommended'
export type NotesOutcome = 'generated' | 'did_not_run'

export const RAM_BUCKETS = ['8gb', '16gb', '32gb+'] as const
export const CPU_CLASSES = ['low', 'recommended'] as const
export const NOTES_OUTCOMES = ['generated', 'did_not_run'] as const

const MAX_DURATION_MIN = 600

export function toRamBucket(totalMemoryGiB: number): RamBucket {
  if (totalMemoryGiB < 12) return '8gb'
  if (totalMemoryGiB < 24) return '16gb'
  return '32gb+'
}

export function toCpuClass(input: {
  profileId?: string | null
  platform: string
  ramBucket: RamBucket
  logicalProcessors: number
}): CpuClass {
  if (input.profileId === 'mac-low-spec' || input.profileId === 'win-low-spec') {
    return 'low'
  }
  if (input.profileId === 'mac-normal' || input.profileId === 'win-cpu-normal' || input.profileId === 'win-gpu') {
    return 'recommended'
  }
  if (input.ramBucket === '8gb') return 'low'
  if (input.platform === 'win32' && input.logicalProcessors < 8) return 'low'
  return 'recommended'
}

export function toHasGpu(input: {
  transcriptionBackend?: string | null
  windowsProfileId?: string | null
}): boolean {
  const backend = input.transcriptionBackend ?? ''
  return (
    backend === 'mlx-whisper' ||
    backend === 'parakeet-gpu' ||
    backend === 'faster-whisper-cuda' ||
    input.windowsProfileId === 'win-gpu'
  )
}

export function roundDurationToMinutes(seconds: number, stepMinutes: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(stepMinutes) || stepMinutes <= 0) {
    return 0
  }
  const minutes = seconds / 60
  const rounded = Math.round(minutes / stepMinutes) * stepMinutes
  return Math.max(0, Math.min(MAX_DURATION_MIN, rounded))
}

export function buildAnalyticsHardwareSnapshot(input: {
  totalMemoryGiB: number
  platform: string
  logicalProcessors: number
  transcriptionBackend?: string | null
  macProfileId?: string | null
  windowsProfileId?: string | null
}): {
  ramBucket: RamBucket
  cpuClass: CpuClass
  hasGpu: boolean
} {
  const ramBucket = toRamBucket(input.totalMemoryGiB)
  return {
    ramBucket,
    cpuClass: toCpuClass({
      profileId: input.macProfileId ?? input.windowsProfileId ?? null,
      platform: input.platform,
      ramBucket,
      logicalProcessors: input.logicalProcessors
    }),
    hasGpu: toHasGpu({
      transcriptionBackend: input.transcriptionBackend,
      windowsProfileId: input.windowsProfileId
    })
  }
}

export function buildMeetingProcessedProperties(input: {
  ramBucket?: RamBucket | null
  cpuClass?: CpuClass | null
  hasGpu?: boolean | null
  recordingDurationSec?: number | null
  transcriptionDurationSec?: number | null
  notesOutcome: NotesOutcome
  notesDurationSec?: number | null
}): Record<string, unknown> | null {
  if (
    input.recordingDurationSec == null ||
    input.transcriptionDurationSec == null ||
    !Number.isFinite(input.recordingDurationSec) ||
    !Number.isFinite(input.transcriptionDurationSec)
  ) {
    return null
  }

  const properties: Record<string, unknown> = {
    ram_bucket: input.ramBucket,
    cpu_class: input.cpuClass,
    has_gpu: input.hasGpu === true,
    recording_duration_min: roundDurationToMinutes(input.recordingDurationSec, 5),
    transcription_duration_min: roundDurationToMinutes(input.transcriptionDurationSec, 1),
    notes_outcome: input.notesOutcome
  }

  if (input.notesOutcome === 'generated' && input.notesDurationSec != null) {
    properties.notes_duration_min = roundDurationToMinutes(input.notesDurationSec, 1)
  }

  return properties
}

export function isRamBucket(value: unknown): value is RamBucket {
  return typeof value === 'string' && (RAM_BUCKETS as readonly string[]).includes(value)
}

export function isCpuClass(value: unknown): value is CpuClass {
  return typeof value === 'string' && (CPU_CLASSES as readonly string[]).includes(value)
}

export function isNotesOutcome(value: unknown): value is NotesOutcome {
  return typeof value === 'string' && (NOTES_OUTCOMES as readonly string[]).includes(value)
}

export function isBoundedDurationMin(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MIN
}
