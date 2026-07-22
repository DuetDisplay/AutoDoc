import { shouldSerializeWindowsLocalProcessing } from './windows-transcription-runtime'

export type WindowsProcessingProfileId = 'win-gpu' | 'win-cpu-normal' | 'win-low-spec'
export type WindowsDualSourceMode = 'concurrent' | 'sequential'
export type WindowsThreadPolicy = 'default' | 'min'

export interface WindowsHardwareSnapshot {
  logicalProcessors: number
  totalMemoryGiB: number | null
  freeMemoryGiB: number | null
}

export interface WindowsMemorySnapshot {
  freeMemoryGiB: number | null
}

export interface WindowsProcessingProfile {
  id: WindowsProcessingProfileId
  label: string
  reason: string
  hardware: WindowsHardwareSnapshot
  dualSourceMode: WindowsDualSourceMode
  serializeLocalProcessing: boolean
  notesAfterTranscriptionOnly: boolean
  threadPolicy: WindowsThreadPolicy
}

const CPU_NORMAL_MIN_LOGICAL_PROCESSORS = 8
const CPU_NORMAL_MIN_TOTAL_MEMORY_GIB = 16
const RUNTIME_DUAL_SOURCE_MIN_FREE_MEMORY_GIB = 4

export function selectWindowsProcessingProfile(
  hardware: WindowsHardwareSnapshot,
  selectedBackendDevice: 'cuda' | 'cpu' | 'dml'
): WindowsProcessingProfile {
  if (selectedBackendDevice === 'dml' || selectedBackendDevice === 'cuda') {
    return createGpuProfile(
      hardware,
      'active transcription backend uses GPU acceleration (DML or CUDA)'
    )
  }

  const totalMemoryGiB = hardware.totalMemoryGiB ?? 0
  if (
    hardware.logicalProcessors >= CPU_NORMAL_MIN_LOGICAL_PROCESSORS &&
    totalMemoryGiB >= CPU_NORMAL_MIN_TOTAL_MEMORY_GIB
  ) {
    return createCpuNormalProfile(
      hardware,
      `hardware has >= ${CPU_NORMAL_MIN_LOGICAL_PROCESSORS} logical processors and >= ${CPU_NORMAL_MIN_TOTAL_MEMORY_GIB} GiB RAM`
    )
  }

  return createLowSpecProfile(
    hardware,
    `hardware has < ${CPU_NORMAL_MIN_LOGICAL_PROCESSORS} logical processors or < ${CPU_NORMAL_MIN_TOTAL_MEMORY_GIB} GiB RAM`
  )
}

export function selectEffectiveWindowsProcessingProfile(
  stableProfile: WindowsProcessingProfile,
  memorySnapshot: WindowsMemorySnapshot
): WindowsProcessingProfile {
  if (stableProfile.id === 'win-low-spec') {
    return createLowSpecProfile(stableProfile.hardware, stableProfile.reason)
  }

  if (stableProfile.id === 'win-gpu') {
    return createGpuProfile(stableProfile.hardware, stableProfile.reason)
  }

  if (!isMemoryHealthyForConcurrentDualSource(memorySnapshot)) {
    return createRuntimePressuredCpuNormalProfile(stableProfile)
  }

  return createCpuNormalProfile(stableProfile.hardware, stableProfile.reason)
}

export function isMemoryHealthyForConcurrentDualSource(
  memorySnapshot: Pick<WindowsMemorySnapshot, 'freeMemoryGiB'>
): boolean {
  return (
    memorySnapshot.freeMemoryGiB != null &&
    memorySnapshot.freeMemoryGiB >= RUNTIME_DUAL_SOURCE_MIN_FREE_MEMORY_GIB
  )
}

function createGpuProfile(
  hardware: WindowsHardwareSnapshot,
  reason: string
): WindowsProcessingProfile {
  return {
    id: 'win-gpu',
    label: 'GPU Windows processing',
    reason,
    hardware,
    dualSourceMode: 'concurrent',
    serializeLocalProcessing: false,
    notesAfterTranscriptionOnly: false,
    threadPolicy: 'default'
  }
}

function createCpuNormalProfile(
  hardware: WindowsHardwareSnapshot,
  reason: string
): WindowsProcessingProfile {
  return {
    id: 'win-cpu-normal',
    label: 'CPU Windows processing',
    reason,
    hardware,
    dualSourceMode: 'concurrent',
    serializeLocalProcessing: shouldSerializeWindowsLocalProcessing(
      hardware.logicalProcessors,
      hardware.freeMemoryGiB
    ),
    notesAfterTranscriptionOnly: false,
    threadPolicy: 'default'
  }
}

function createLowSpecProfile(
  hardware: WindowsHardwareSnapshot,
  reason: string
): WindowsProcessingProfile {
  return {
    id: 'win-low-spec',
    label: 'Low-spec Windows processing',
    reason,
    hardware,
    dualSourceMode: 'sequential',
    serializeLocalProcessing: true,
    notesAfterTranscriptionOnly: true,
    threadPolicy: 'min'
  }
}

function createRuntimePressuredCpuNormalProfile(
  stableProfile: WindowsProcessingProfile
): WindowsProcessingProfile {
  return {
    ...stableProfile,
    reason: 'runtime free memory is below the threshold for concurrent dual-source transcription',
    dualSourceMode: 'sequential',
    serializeLocalProcessing: true,
    notesAfterTranscriptionOnly: true,
    threadPolicy: 'min'
  }
}
