import { describe, expect, it } from 'vitest'
import {
  isMemoryHealthyForConcurrentDualSource,
  selectEffectiveWindowsProcessingProfile,
  selectWindowsProcessingProfile,
  type WindowsHardwareSnapshot
} from '../windows-processing-profile'

function hardware(overrides: Partial<WindowsHardwareSnapshot> = {}): WindowsHardwareSnapshot {
  return {
    logicalProcessors: 16,
    totalMemoryGiB: 32,
    freeMemoryGiB: 16,
    ...overrides
  }
}

describe('windows processing profile selection', () => {
  it('selects GPU mode for DML backends', () => {
    const profile = selectWindowsProcessingProfile(hardware(), 'dml')

    expect(profile.id).toBe('win-gpu')
    expect(profile.dualSourceMode).toBe('concurrent')
    expect(profile.serializeLocalProcessing).toBe(false)
    expect(profile.threadPolicy).toBe('default')
  })

  it('selects GPU mode for CUDA backends', () => {
    const profile = selectWindowsProcessingProfile(hardware({ logicalProcessors: 4 }), 'cuda')

    expect(profile.id).toBe('win-gpu')
    expect(profile.dualSourceMode).toBe('concurrent')
  })

  it('selects CPU normal mode for capable CPU backends', () => {
    const profile = selectWindowsProcessingProfile(
      hardware({ logicalProcessors: 12, totalMemoryGiB: 24, freeMemoryGiB: 8 }),
      'cpu'
    )

    expect(profile.id).toBe('win-cpu-normal')
    expect(profile.dualSourceMode).toBe('concurrent')
    expect(profile.serializeLocalProcessing).toBe(false)
    expect(profile.notesAfterTranscriptionOnly).toBe(false)
  })

  it('serializes local processing for CPU normal mode under runtime pressure', () => {
    const profile = selectWindowsProcessingProfile(
      hardware({ logicalProcessors: 16, totalMemoryGiB: 32, freeMemoryGiB: 4 }),
      'cpu'
    )

    expect(profile.id).toBe('win-cpu-normal')
    expect(profile.serializeLocalProcessing).toBe(true)
  })

  it('selects low-spec mode for weaker CPU backends', () => {
    const profile = selectWindowsProcessingProfile(
      hardware({ logicalProcessors: 6, totalMemoryGiB: 12, freeMemoryGiB: 8 }),
      'cpu'
    )

    expect(profile.id).toBe('win-low-spec')
    expect(profile.dualSourceMode).toBe('sequential')
    expect(profile.serializeLocalProcessing).toBe(true)
    expect(profile.notesAfterTranscriptionOnly).toBe(true)
    expect(profile.threadPolicy).toBe('min')
  })

  it('temporarily applies low-spec behavior to CPU normal hardware under runtime memory pressure', () => {
    const stableProfile = selectWindowsProcessingProfile(
      hardware({ logicalProcessors: 16, totalMemoryGiB: 32, freeMemoryGiB: 12 }),
      'cpu'
    )
    const pressuredProfile = selectEffectiveWindowsProcessingProfile(stableProfile, {
      freeMemoryGiB: 2
    })
    const recoveredProfile = selectEffectiveWindowsProcessingProfile(stableProfile, {
      freeMemoryGiB: 12
    })

    expect(pressuredProfile.id).toBe('win-cpu-normal')
    expect(pressuredProfile.dualSourceMode).toBe('sequential')
    expect(pressuredProfile.serializeLocalProcessing).toBe(true)
    expect(pressuredProfile.notesAfterTranscriptionOnly).toBe(true)
    expect(pressuredProfile.threadPolicy).toBe('min')
    expect(recoveredProfile.id).toBe('win-cpu-normal')
    expect(recoveredProfile.dualSourceMode).toBe('concurrent')
    expect(recoveredProfile.serializeLocalProcessing).toBe(false)
    expect(recoveredProfile.notesAfterTranscriptionOnly).toBe(false)
  })

  it('keeps GPU mode concurrent even when runtime memory is low', () => {
    const stableProfile = selectWindowsProcessingProfile(hardware(), 'dml')
    const effectiveProfile = selectEffectiveWindowsProcessingProfile(stableProfile, {
      freeMemoryGiB: 1
    })

    expect(effectiveProfile.id).toBe('win-gpu')
    expect(effectiveProfile.dualSourceMode).toBe('concurrent')
    expect(effectiveProfile.serializeLocalProcessing).toBe(false)
  })

  it('keeps low-spec stable profile at runtime', () => {
    const stableProfile = selectWindowsProcessingProfile(
      hardware({ logicalProcessors: 4, totalMemoryGiB: 8 }),
      'cpu'
    )
    const effectiveProfile = selectEffectiveWindowsProcessingProfile(stableProfile, {
      freeMemoryGiB: 10
    })

    expect(effectiveProfile.id).toBe('win-low-spec')
    expect(effectiveProfile.dualSourceMode).toBe('sequential')
    expect(effectiveProfile.threadPolicy).toBe('min')
  })

  it('treats low free memory as unsafe for concurrent dual-source transcription', () => {
    expect(isMemoryHealthyForConcurrentDualSource({ freeMemoryGiB: 3.9 })).toBe(false)
    expect(isMemoryHealthyForConcurrentDualSource({ freeMemoryGiB: 4 })).toBe(true)
    expect(isMemoryHealthyForConcurrentDualSource({ freeMemoryGiB: null })).toBe(false)
  })
})
