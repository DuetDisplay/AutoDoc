import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildWindowsMultilingualSelfTestKey,
  CANARY_CUDA_MIN_VRAM_GIB,
  getWindowsRouteFirstUseDownloadBytes,
  invalidateWindowsMultilingualSelfTestsForEngine,
  listWindowsMultilingualEngineAssets,
  lockedNeedsSupportedGraphicsCardReason,
  lookupWindowsMultilingualSelfTest,
  readWindowsMultilingualSelfTestStore,
  resolveWindowsMultilingualEngine,
  selectWindowsMultilingualGpuSnapshot,
  selfTestMapFromStore,
  upsertWindowsMultilingualSelfTest,
  windowsMultilingualAssetVersion,
  windowsMultilingualSelfTestCachePath,
  writeWindowsMultilingualSelfTestResult,
  type WindowsMultilingualGpuSnapshot,
  type WindowsMultilingualSelfTestRecord
} from '../windows-multilingual-engine'
import {
  FASTER_WHISPER_CUDA_RUNTIME_FILENAME,
  PARAKEET_RUNTIME_FILENAME,
  WINDOWS_TRANSCRIPTION_PROFILES
} from '../windows-transcription-runtime'

const nvidia: WindowsMultilingualGpuSnapshot = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
  vramGiB: 8,
  discrete: true,
  driverVersion: '581.95'
}

const amd: WindowsMultilingualGpuSnapshot = {
  vendor: 'amd',
  name: 'AMD Radeon RX 6800',
  vramGiB: 16,
  discrete: true,
  driverVersion: null
}

const intel: WindowsMultilingualGpuSnapshot = {
  vendor: 'intel',
  name: 'Intel(R) Iris(R) Xe Graphics',
  vramGiB: 1,
  discrete: false,
  driverVersion: null
}

const none: WindowsMultilingualGpuSnapshot = {
  vendor: 'none',
  name: '',
  vramGiB: null,
  discrete: false,
  driverVersion: null
}

describe('resolveWindowsMultilingualEngine', () => {
  it('leaves the English route unchanged on every processing profile', () => {
    for (const profileId of ['win-gpu', 'win-cpu-normal', 'win-low-spec'] as const) {
      expect(
        resolveWindowsMultilingualEngine({
          route: 'english',
          profileId,
          gpu: nvidia
        })
      ).toEqual({
        route: 'english',
        kind: 'unchanged',
        primary: null,
        fallbacks: [],
        availability: 'available',
        reason: null
      })
    }
  })

  it('routes Canary to CUDA fp32 on NVIDIA when VRAM and self-test allow it', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'canary',
      profileId: 'win-gpu',
      gpu: nvidia
    })

    expect(CANARY_CUDA_MIN_VRAM_GIB).toBe(6)
    expect(plan.kind).toBe('resolved')
    expect(plan.primary?.engine).toBe('canary-cuda')
    expect(plan.fallbacks.map((choice) => choice.engine)).toEqual(['canary-cpu'])
    expect(plan.availability).toBe('available')
  })

  it('falls back to Canary int8 CPU when NVIDIA VRAM is below 6 GiB', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'canary',
      profileId: 'win-gpu',
      gpu: { ...nvidia, vramGiB: 4 }
    })

    expect(plan.primary?.engine).toBe('canary-cpu')
    expect(plan.fallbacks).toEqual([])
  })

  it('falls back to Canary int8 CPU when the CUDA self-test failed', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'canary',
      profileId: 'win-gpu',
      gpu: nvidia,
      selfTests: { 'canary-cuda': 'failed' }
    })

    expect(plan.primary?.engine).toBe('canary-cpu')
  })

  it('uses Canary CPU on AMD, Intel, CPU-normal and low-spec machines', () => {
    for (const [profileId, gpu] of [
      ['win-gpu', amd],
      ['win-gpu', intel],
      ['win-cpu-normal', none],
      ['win-low-spec', none]
    ] as const) {
      const plan = resolveWindowsMultilingualEngine({
        route: 'canary',
        profileId,
        gpu
      })
      expect(plan.primary?.engine).toBe('canary-cpu')
      expect(plan.availability).toBe('available')
    }
  })

  it('tries Canary CUDA when NVIDIA VRAM is unknown because the self-test is the real gate', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'canary',
      profileId: 'win-gpu',
      gpu: { ...nvidia, vramGiB: null }
    })
    expect(plan.primary?.engine).toBe('canary-cuda')
  })

  it('routes turbo on NVIDIA to faster-whisper CUDA with a CPU fallback on win-cpu-normal', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: nvidia
    })
    expect(plan.primary?.engine).toBe('whisper-turbo-cuda')
    expect(plan.fallbacks).toEqual([
      { engine: 'whisper-turbo-cpu', availability: 'slower', reason: null }
    ])
  })

  it('routes turbo on AMD and Intel to whisper.cpp Vulkan', () => {
    expect(
      resolveWindowsMultilingualEngine({
        route: 'whisper-turbo',
        profileId: 'win-gpu',
        gpu: amd
      }).primary?.engine
    ).toBe('whisper-turbo-vulkan')
    expect(
      resolveWindowsMultilingualEngine({
        route: 'whisper-turbo',
        profileId: 'win-gpu',
        gpu: intel
      }).primary?.engine
    ).toBe('whisper-turbo-vulkan')
  })

  it('allows GPU turbo on low-spec when the GPU self-test has not failed', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-low-spec',
      gpu: nvidia,
      languageLabel: 'Spanish'
    })
    expect(plan.primary?.engine).toBe('whisper-turbo-cuda')
    expect(plan.fallbacks).toEqual([])
    expect(plan.availability).toBe('available')
  })

  it('locks turbo on low-spec when no GPU path passes the self-test', () => {
    const reason = lockedNeedsSupportedGraphicsCardReason('Spanish')
    expect(reason).toBe('Spanish needs a supported graphics card on this PC.')

    for (const gpu of [none, { ...nvidia, vendor: 'nvidia' as const }]) {
      const plan = resolveWindowsMultilingualEngine({
        route: 'whisper-turbo',
        profileId: 'win-low-spec',
        gpu,
        selfTests: gpu.vendor === 'nvidia' ? { 'whisper-turbo-cuda': 'failed' } : {},
        languageLabel: 'Spanish'
      })
      expect(plan.primary).toBeNull()
      expect(plan.availability).toBe('locked')
      expect(plan.reason).toBe(reason)
    }
  })

  it('does not use CUDA turbo when NVIDIA VRAM is known and below the profile floor', () => {
    expect(WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cuda'].minVramGiB).toBe(
      WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cuda'].minVramGiB
    )
    const lowVramNvidia = { ...nvidia, vramGiB: 4 }
    const normal = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: lowVramNvidia
    })
    const lowSpec = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-low-spec',
      gpu: lowVramNvidia,
      languageLabel: 'Spanish'
    })

    expect(normal.primary).toEqual({
      engine: 'whisper-turbo-cpu',
      availability: 'slower',
      reason: null
    })
    expect(normal.fallbacks).toEqual([])
    expect(lowSpec.primary).toBeNull()
    expect(lowSpec.availability).toBe('locked')
    expect(lowSpec.reason).toBe('Spanish needs a supported graphics card on this PC.')
  })

  it('still tries CUDA turbo when NVIDIA VRAM is unknown', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: { ...nvidia, vramGiB: null }
    })
    expect(plan.primary?.engine).toBe('whisper-turbo-cuda')
  })

  it('reads the turbo CUDA VRAM floor from the profile instead of a new constant', () => {
    const profiles = {
      ...WINDOWS_TRANSCRIPTION_PROFILES,
      'whisper-turbo-cuda': {
        ...WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cuda'],
        minVramGiB: 4
      }
    }
    const plan = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: { ...nvidia, vramGiB: 4 },
      profiles
    })
    expect(plan.primary?.engine).toBe('whisper-turbo-cuda')
  })

  it('does not fall back to Vulkan for NVIDIA cards below the turbo CUDA floor', () => {
    const plan = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: { ...nvidia, vramGiB: 4 }
    })
    expect(plan.primary?.engine).toBe('whisper-turbo-cpu')
    expect(plan.fallbacks.map((choice) => choice.engine)).not.toContain('whisper-turbo-vulkan')
  })

  it('uses slower CPU turbo on win-cpu-normal when the GPU self-test failed or no GPU is present', () => {
    const failedGpu = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: intel,
      selfTests: { 'whisper-turbo-vulkan': 'failed' }
    })
    const cpuOnly = resolveWindowsMultilingualEngine({
      route: 'whisper-turbo',
      profileId: 'win-cpu-normal',
      gpu: none
    })

    expect(failedGpu.primary).toEqual({
      engine: 'whisper-turbo-cpu',
      availability: 'slower',
      reason: null
    })
    expect(cpuOnly.availability).toBe('slower')
    expect(cpuOnly.primary?.engine).toBe('whisper-turbo-cpu')
  })
})

describe('Windows multilingual assets and download size', () => {
  it('reports the packaged Canary CUDA first-use download size', () => {
    expect(
      getWindowsRouteFirstUseDownloadBytes({
        route: 'canary',
        engineId: 'canary-cuda'
      })
    ).toBe(1_897_898_949 + 3_680_120_548)
  })

  it('returns 0 for the English route so Settings keeps the existing English installer', () => {
    expect(
      getWindowsRouteFirstUseDownloadBytes({
        route: 'english',
        engineId: 'unchanged'
      })
    ).toBe(0)
  })

  it('omits assets that are already installed, including the shared turbo model', () => {
    const installed = new Set([FASTER_WHISPER_CUDA_RUNTIME_FILENAME])
    expect(
      getWindowsRouteFirstUseDownloadBytes({
        route: 'whisper-turbo',
        engineId: 'whisper-turbo-cuda',
        isAssetPresent: (filename) => installed.has(filename)
      })
    ).toBe(1_492_333_094)
  })

  it('includes the parakeet Python runtime in the Vulkan turbo download set', () => {
    const filenames = listWindowsMultilingualEngineAssets('whisper-turbo-vulkan').map(
      (asset) => asset.filename
    )
    expect(filenames).toEqual([
      'whisper-cpp-vulkan-runtime-win-x64.zip',
      'ggml-large-v3-turbo.zip',
      PARAKEET_RUNTIME_FILENAME
    ])
  })

  it('does not count Canary CPU runtime again when Parakeet is already installed', () => {
    expect(
      getWindowsRouteFirstUseDownloadBytes({
        route: 'canary',
        engineId: 'canary-cpu',
        isAssetPresent: (filename) => filename === PARAKEET_RUNTIME_FILENAME
      })
    ).toBe(WINDOWS_TRANSCRIPTION_PROFILES['canary-cpu'].assets[1].bytes)
  })
})

describe('Windows multilingual GPU snapshot and self-test cache', () => {
  it('prefers a discrete NVIDIA GPU and keeps its nvidia-smi driver version', () => {
    expect(
      selectWindowsMultilingualGpuSnapshot([
        { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 },
        {
          name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          vendor: 'nvidia',
          adapterRamGiB: 8,
          driverVersion: '581.95'
        }
      ])
    ).toEqual(nvidia)
  })

  it('stores and invalidates self-test results when the cache key changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autodoc-self-test-'))
    const path = windowsMultilingualSelfTestCachePath(root)
    const key = buildWindowsMultilingualSelfTestKey({
      engine: 'canary-cuda',
      gpuName: nvidia.name,
      driverVersion: '581.95',
      assetVersion: windowsMultilingualAssetVersion('canary-cuda')
    })
    const record: WindowsMultilingualSelfTestRecord = {
      key,
      engine: 'canary-cuda',
      gpuName: nvidia.name,
      driverVersion: '581.95',
      assetVersion: windowsMultilingualAssetVersion('canary-cuda'),
      result: 'passed',
      testedAt: '2026-10-02T00:00:00.000Z'
    }

    try {
      expect(await readWindowsMultilingualSelfTestStore(path)).toBeNull()
      await writeWindowsMultilingualSelfTestResult(path, record)
      const stored = await readWindowsMultilingualSelfTestStore(path)
      expect(lookupWindowsMultilingualSelfTest(stored, key)?.result).toBe('passed')
      expect(
        lookupWindowsMultilingualSelfTest(
          stored,
          buildWindowsMultilingualSelfTestKey({
            engine: 'canary-cuda',
            gpuName: nvidia.name,
            driverVersion: '999.99',
            assetVersion: record.assetVersion
          })
        )
      ).toBeNull()

      const invalidated = invalidateWindowsMultilingualSelfTestsForEngine(stored, 'canary-cuda')
      expect(lookupWindowsMultilingualSelfTest(invalidated, key)).toBeNull()
      expect(
        selfTestMapFromStore(stored, {
          'canary-cuda': key,
          'canary-cpu': 'missing'
        })
      ).toEqual({
        'canary-cuda': 'passed',
        'canary-cpu': 'untested'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a version mismatch as an empty cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autodoc-self-test-ver-'))
    const path = join(root, 'cache.json')
    try {
      await writeFile(path, JSON.stringify({ version: 2, records: { x: {} } }))
      expect(await readWindowsMultilingualSelfTestStore(path)).toBeNull()
      const next = upsertWindowsMultilingualSelfTest(null, {
        key: 'k',
        engine: 'canary-cpu',
        gpuName: '',
        driverVersion: '',
        assetVersion: 'v',
        result: 'failed',
        testedAt: '2026-10-02T00:00:00.000Z'
      })
      expect(next.version).toBe(1)
      expect(next.records.k.result).toBe('failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
