import { describe, expect, it } from 'vitest'
import {
  buildAnalyticsHardwareSnapshot,
  buildMeetingProcessedProperties,
  roundDurationToMinutes,
  toCpuClass,
  toHasGpu,
  toRamBucket
} from '../analytics-metrics'

describe('analytics metrics', () => {
  it('maps total memory into coarse RAM buckets', () => {
    expect(toRamBucket(8)).toBe('8gb')
    expect(toRamBucket(8.5)).toBe('8gb')
    expect(toRamBucket(16)).toBe('16gb')
    expect(toRamBucket(18)).toBe('16gb')
    expect(toRamBucket(24)).toBe('32gb+')
    expect(toRamBucket(36)).toBe('32gb+')
  })

  it('uses the stable processing profile for CPU class when present', () => {
    expect(
      toCpuClass({
        profileId: 'mac-low-spec',
        platform: 'darwin',
        ramBucket: '8gb',
        logicalProcessors: 8
      })
    ).toBe('low')
    expect(
      toCpuClass({
        profileId: 'win-gpu',
        platform: 'win32',
        ramBucket: '16gb',
        logicalProcessors: 12
      })
    ).toBe('recommended')
  })

  it('falls back to RAM and core count when no profile is selected yet', () => {
    expect(
      toCpuClass({
        profileId: null,
        platform: 'win32',
        ramBucket: '16gb',
        logicalProcessors: 4
      })
    ).toBe('low')
    expect(
      toCpuClass({
        profileId: null,
        platform: 'darwin',
        ramBucket: '16gb',
        logicalProcessors: 10
      })
    ).toBe('recommended')
  })

  it('treats Apple Silicon MLX and Windows GPU backends as has_gpu', () => {
    expect(toHasGpu({ transcriptionBackend: 'mlx-whisper' })).toBe(true)
    expect(toHasGpu({ transcriptionBackend: 'parakeet-cpu', windowsProfileId: 'win-low-spec' })).toBe(
      false
    )
    expect(toHasGpu({ transcriptionBackend: 'parakeet-cpu', windowsProfileId: 'win-gpu' })).toBe(true)
  })

  it('rounds meeting length to 5 minutes and processing time to 1 minute', () => {
    expect(roundDurationToMinutes(7 * 60, 5)).toBe(5)
    expect(roundDurationToMinutes(8 * 60, 5)).toBe(10)
    expect(roundDurationToMinutes(45 * 60, 5)).toBe(45)
    expect(roundDurationToMinutes(80, 1)).toBe(1)
    expect(roundDurationToMinutes(20, 1)).toBe(0)
  })

  it('builds a meeting_processed row only when recording and transcription times exist', () => {
    expect(
      buildMeetingProcessedProperties({
        ramBucket: '16gb',
        cpuClass: 'recommended',
        hasGpu: true,
        notesOutcome: 'generated',
        notesDurationSec: 200
      })
    ).toBeNull()

    expect(
      buildMeetingProcessedProperties({
        ramBucket: '8gb',
        cpuClass: 'low',
        hasGpu: false,
        recordingDurationSec: 32 * 60,
        transcriptionDurationSec: 11 * 60 + 20,
        notesOutcome: 'did_not_run'
      })
    ).toEqual({
      ram_bucket: '8gb',
      cpu_class: 'low',
      has_gpu: false,
      recording_duration_min: 30,
      transcription_duration_min: 11,
      notes_outcome: 'did_not_run'
    })
  })

  it('includes rounded notes time only when notes were generated', () => {
    expect(
      buildMeetingProcessedProperties({
        ramBucket: '32gb+',
        cpuClass: 'recommended',
        hasGpu: true,
        recordingDurationSec: 44 * 60,
        transcriptionDurationSec: 7 * 60 + 40,
        notesOutcome: 'generated',
        notesDurationSec: 3 * 60 + 20
      })
    ).toEqual({
      ram_bucket: '32gb+',
      cpu_class: 'recommended',
      has_gpu: true,
      recording_duration_min: 45,
      transcription_duration_min: 8,
      notes_outcome: 'generated',
      notes_duration_min: 3
    })
  })

  it('assembles hardware snapshot fields for runtime info', () => {
    expect(
      buildAnalyticsHardwareSnapshot({
        totalMemoryGiB: 8.1,
        platform: 'darwin',
        logicalProcessors: 8,
        transcriptionBackend: 'mlx-whisper',
        macProfileId: 'mac-low-spec'
      })
    ).toEqual({
      ramBucket: '8gb',
      cpuClass: 'low',
      hasGpu: true
    })
  })
})
