import { availableParallelism, cpus, totalmem } from 'os'
import { buildAnalyticsHardwareSnapshot } from '../../shared/analytics-metrics'
import type { AppRuntimeInfo } from '../../shared/types'
import { getSystemMemorySnapshot } from './windows-transcription-runtime'
import type { WhisperManager } from './whisper-manager'

const GIB = 1024 ** 3

export function getRuntimeAnalyticsHardware(whisperManager: WhisperManager): Pick<
  AppRuntimeInfo,
  'ramBucket' | 'cpuClass' | 'hasGpu'
> {
  const memorySnapshot = getSystemMemorySnapshot()
  const totalMemoryGiB = memorySnapshot.totalMemoryGiB ?? totalmem() / GIB
  const logicalProcessors = getLogicalProcessorCount()

  return buildAnalyticsHardwareSnapshot({
    totalMemoryGiB,
    platform: process.platform,
    logicalProcessors,
    transcriptionBackend: whisperManager.getTranscriptionBackend(),
    macProfileId: whisperManager.getMacProcessingProfile()?.id ?? null,
    windowsProfileId: whisperManager.getWindowsProcessingProfile()?.id ?? null
  })
}

function getLogicalProcessorCount(): number {
  try {
    return availableParallelism()
  } catch {
    return Math.max(1, cpus().length)
  }
}
