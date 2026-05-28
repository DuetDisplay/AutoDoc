import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OLLAMA_MODEL,
  LOW_SPEC_MAC_OLLAMA_MODEL
} from '../../../shared/constants'
import {
  isMemoryHealthyForConcurrentProcessing,
  parseMacAvailableMemoryGiBFromVmStat,
  parseMacMemoryPressureOutput,
  selectEffectiveMacProcessingProfile,
  selectMacProcessingProfile,
  type MacHardwareSnapshot
} from '../mac-processing-profile'

function hardware(overrides: Partial<MacHardwareSnapshot> = {}): MacHardwareSnapshot {
  return {
    platform: 'darwin',
    arch: 'arm64',
    isAppleSilicon: true,
    chip: 'Apple M1',
    logicalProcessors: 8,
    totalMemoryGiB: 16,
    freeMemoryGiB: 8,
    memoryPressure: 'green',
    swapUsedGiB: 0,
    ...overrides
  }
}

describe('mac processing profile selection', () => {
  it('selects low-spec mode for 8 GB Apple Silicon Macs', () => {
    const profile = selectMacProcessingProfile(hardware({ totalMemoryGiB: 8 }))

    expect(profile.id).toBe('mac-low-spec')
    expect(profile.notesModel).toBe(LOW_SPEC_MAC_OLLAMA_MODEL)
    expect(profile.dualSourceMode).toBe('sequential')
    expect(profile.serializeLocalProcessing).toBe(true)
  })

  it('selects normal mode for healthy higher-memory Apple Silicon Macs', () => {
    const profile = selectMacProcessingProfile(hardware({ totalMemoryGiB: 24, freeMemoryGiB: 12 }))

    expect(profile.id).toBe('mac-normal')
    expect(profile.notesModel).toBe(DEFAULT_OLLAMA_MODEL)
    expect(profile.dualSourceMode).toBe('concurrent')
    expect(profile.serializeLocalProcessing).toBe(false)
  })

  it('keeps normal-spec hardware stable when setup happens under temporary memory pressure', () => {
    const profile = selectMacProcessingProfile(
      hardware({ totalMemoryGiB: 24, freeMemoryGiB: 2, memoryPressure: 'yellow' })
    )

    expect(profile.id).toBe('mac-normal')
    expect(profile.dualSourceMode).toBe('concurrent')
    expect(profile.serializeLocalProcessing).toBe(false)
  })

  it('temporarily applies low-spec behavior to normal hardware under runtime pressure', () => {
    const stableProfile = selectMacProcessingProfile(
      hardware({ totalMemoryGiB: 24, freeMemoryGiB: 12, memoryPressure: 'green' })
    )
    const pressuredProfile = selectEffectiveMacProcessingProfile(
      stableProfile,
      hardware({ totalMemoryGiB: 24, freeMemoryGiB: 2, memoryPressure: 'yellow' })
    )
    const recoveredProfile = selectEffectiveMacProcessingProfile(
      stableProfile,
      hardware({ totalMemoryGiB: 24, freeMemoryGiB: 12, memoryPressure: 'green' })
    )

    expect(pressuredProfile.id).toBe('mac-low-spec')
    expect(pressuredProfile.notesModel).toBe(DEFAULT_OLLAMA_MODEL)
    expect(pressuredProfile.dualSourceMode).toBe('sequential')
    expect(pressuredProfile.serializeLocalProcessing).toBe(true)
    expect(recoveredProfile.id).toBe('mac-normal')
    expect(recoveredProfile.notesModel).toBe(DEFAULT_OLLAMA_MODEL)
    expect(recoveredProfile.dualSourceMode).toBe('concurrent')
    expect(recoveredProfile.serializeLocalProcessing).toBe(false)
  })

  it('keeps the low-spec notes model stable for 8 GB Apple Silicon Macs at runtime', () => {
    const stableProfile = selectMacProcessingProfile(hardware({ totalMemoryGiB: 8 }))
    const effectiveProfile = selectEffectiveMacProcessingProfile(
      stableProfile,
      hardware({ totalMemoryGiB: 8, freeMemoryGiB: 5, memoryPressure: 'green' })
    )

    expect(effectiveProfile.id).toBe('mac-low-spec')
    expect(effectiveProfile.notesModel).toBe(LOW_SPEC_MAC_OLLAMA_MODEL)
  })

  it('treats memory pressure and swap as unsafe for concurrency', () => {
    expect(
      isMemoryHealthyForConcurrentProcessing(
        hardware({ totalMemoryGiB: 24, freeMemoryGiB: 12, memoryPressure: 'yellow' })
      )
    ).toBe(false)
    expect(
      isMemoryHealthyForConcurrentProcessing(
        hardware({ totalMemoryGiB: 24, freeMemoryGiB: 12, swapUsedGiB: 3 })
      )
    ).toBe(false)
  })

  it('does not parse wired memory as red pressure', () => {
    const output = `
Pages wired down:                        236029.
System-wide memory free percentage: 84%
`

    expect(parseMacMemoryPressureOutput(output)).toBe('green')
  })

  it('counts reclaimable macOS memory from vm_stat', () => {
    const output = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               21780.
Pages inactive:                          627945.
Pages speculative:                         3049.
Pages wired down:                        236029.
`

    expect(parseMacAvailableMemoryGiBFromVmStat(output)).toBe(9.96)
  })
})
