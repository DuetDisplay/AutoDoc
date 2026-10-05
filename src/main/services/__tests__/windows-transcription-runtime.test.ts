import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyNvidiaSmiMemory,
  applyRegistryGpuMemory,
  CANARY_CUDA_MIN_VRAM_GIB,
  classifyWindowsGpuVendor,
  electronMemoryKbToGiB,
  ENGLISH_WINDOWS_TRANSCRIPTION_BACKEND_IDS,
  getUsableLogicalProcessorCount,
  isLikelyDiscreteGpuName,
  loadWindowsTranscriptionProfiles,
  normalizeImplausibleDiscreteVram,
  parseNvidiaSmiGpuRows,
  parseWindowsRegistryGpuRows,
  selectWindowsTranscriptionProfile,
  shouldSerializeWindowsLocalProcessing,
  WINDOWS_TRANSCRIPTION_PROFILES,
  type WindowsHardwareProfile,
  type WindowsGpuInfo,
  type WindowsTranscriptionBackendId
} from '../windows-transcription-runtime'

const baseHardware: WindowsHardwareProfile = {
  platform: 'win32',
  arch: 'x64',
  logicalProcessors: 16,
  freeMemoryGiB: 16,
  totalMemoryGiB: 32,
  gpus: []
}

afterEach(() => {
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND
  delete process.env.AUTODOC_TEST_LOGICAL_PROCESSORS
})

describe('Windows transcription runtime selection', () => {
  it('serializes local processing on low-core Windows machines', () => {
    expect(shouldSerializeWindowsLocalProcessing(4, 16)).toBe(true)
  })

  it('serializes local processing when free memory is below the floor', () => {
    expect(shouldSerializeWindowsLocalProcessing(20, 3)).toBe(true)
  })

  it('allows concurrent local processing on capable Windows machines', () => {
    expect(shouldSerializeWindowsLocalProcessing(20, 16)).toBe(false)
  })

  it('allows concurrent local processing when free memory is unknown', () => {
    expect(shouldSerializeWindowsLocalProcessing(20, null)).toBe(false)
  })

  it('honors the logical-processor test override', () => {
    process.env.AUTODOC_TEST_LOGICAL_PROCESSORS = '4'
    expect(getUsableLogicalProcessorCount()).toBe(4)
  })

  it('ignores invalid logical-processor overrides', () => {
    process.env.AUTODOC_TEST_LOGICAL_PROCESSORS = 'not-a-number'
    expect(getUsableLogicalProcessorCount()).toBeGreaterThanOrEqual(1)

    process.env.AUTODOC_TEST_LOGICAL_PROCESSORS = '0'
    expect(getUsableLogicalProcessorCount()).toBeGreaterThanOrEqual(1)
  })

  it('uses the public asset-only repository for fallback asset URLs', () => {
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cpu'].assets[0].url).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/windows-transcription-v3/faster-whisper-runtime-cpu-win-x64.zip'
    )
    expect(WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu'].assets[0].url).toBe(
      'https://github.com/DuetDisplay/AutoDoc/releases/download/windows-transcription-v3/parakeet-runtime-win-x64.zip'
    )
  })

  it('converts Electron memory snapshots from kilobytes to GiB', () => {
    expect(electronMemoryKbToGiB(33_554_432)).toBe(32)
    expect(electronMemoryKbToGiB(1_048_576)).toBe(1)
  })

  it('selects parakeet-gpu for AMD GPUs with enough VRAM', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'AMD Radeon RX 6800',
          vendor: 'amd',
          adapterRamGiB: 8
        }
      ]
    })

    expect(profile.id).toBe('parakeet-gpu')
    expect(profile.engine).toBe('parakeet')
    expect(profile.computeType).toBe('fp32')
  })

  it('selects parakeet-gpu for Intel iGPU with unknown VRAM and 16 GiB RAM', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      totalMemoryGiB: 16,
      gpus: [
        {
          name: 'Intel(R) Arc(TM) Graphics',
          vendor: 'intel',
          adapterRamGiB: null
        }
      ]
    })

    expect(profile.id).toBe('parakeet-gpu')
  })

  it('selects parakeet-cpu for Intel iGPU with unknown VRAM and 8 GiB RAM', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      totalMemoryGiB: 8,
      gpus: [
        {
          name: 'Intel(R) UHD Graphics',
          vendor: 'intel',
          adapterRamGiB: null
        }
      ]
    })

    expect(profile.id).toBe('parakeet-cpu')
    expect(profile.computeType).toBe('int8')
  })

  it('selects parakeet-cpu when no GPUs are present', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: []
    })

    expect(profile.id).toBe('parakeet-cpu')
  })

  it('ignores unknown-vendor virtual display adapters when selecting parakeet-gpu', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'Parsec Virtual Display Adapter',
          vendor: 'unknown',
          adapterRamGiB: 16
        }
      ]
    })

    expect(profile.id).toBe('parakeet-cpu')
  })

  it('uses nvidia-smi VRAM when WMI underreports NVIDIA laptop GPU memory', () => {
    const gpus = applyNvidiaSmiMemory(
      [
        {
          name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          vendor: 'nvidia',
          adapterRamGiB: 4
        }
      ],
      parseNvidiaSmiGpuRows('NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 581.95')
    )

    expect(gpus[0].adapterRamGiB).toBe(8)

    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus
    })

    expect(profile.id).toBe('parakeet-gpu')
  })

  it('parses registry GPU rows with QWORD memory sizes above 4 GiB', () => {
    const entries = parseWindowsRegistryGpuRows([
      {
        AdapterString: 'NVIDIA GeForce RTX 4090',
        qwMemorySize: 25_769_803_776
      }
    ])

    expect(entries).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4090',
        vramGiB: 24
      }
    ])
  })

  it('handles registry GPU rows with missing memory values', () => {
    const entries = parseWindowsRegistryGpuRows([
      {
        DriverDesc: 'Intel(R) UHD Graphics 770',
        qwMemorySize: null
      }
    ])

    expect(entries).toEqual([
      {
        name: 'Intel(R) UHD Graphics 770',
        vramGiB: null
      }
    ])
  })

  it('merges registry VRAM into WMI GPU rows by adapter name', () => {
    const gpus = applyRegistryGpuMemory(
      [
        {
          name: 'NVIDIA GeForce RTX 4090',
          vendor: 'nvidia',
          adapterRamGiB: 4
        }
      ],
      parseWindowsRegistryGpuRows([
        {
          AdapterString: 'NVIDIA GeForce RTX 4090',
          qwMemorySize: 25_769_803_776
        }
      ])
    )

    expect(gpus[0].adapterRamGiB).toBe(24)
  })

  it('keeps the larger of WMI and registry VRAM when both report a value', () => {
    const registryLarger = applyRegistryGpuMemory(
      [
        {
          name: 'Intel(R) Arc(TM) A370M Graphics',
          vendor: 'intel',
          adapterRamGiB: 1
        }
      ],
      [{ name: 'Intel(R) Arc(TM) A370M Graphics', vramGiB: 4 }]
    )
    expect(registryLarger[0].adapterRamGiB).toBe(4)

    const wmiLarger = applyRegistryGpuMemory(
      [
        {
          name: 'Intel(R) Arc(TM) A370M Graphics',
          vendor: 'intel',
          adapterRamGiB: 8
        }
      ],
      [{ name: 'Intel(R) Arc(TM) A370M Graphics', vramGiB: 1 }]
    )
    expect(wmiLarger[0].adapterRamGiB).toBe(8)
  })

  it('selects parakeet-gpu for Arc A370M when WMI underreports VRAM on a 32 GiB machine', () => {
    const fixtureGpus: WindowsGpuInfo[] = [
      { name: 'Intel(R) Arc(TM) A370M Graphics', vendor: 'intel', adapterRamGiB: 1 },
      { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 },
      { name: 'Duet Display', vendor: 'unknown', adapterRamGiB: null },
      { name: 'Duet Display', vendor: 'unknown', adapterRamGiB: null }
    ]

    const profile = selectWindowsTranscriptionProfile({
      platform: 'win32',
      arch: 'x64',
      logicalProcessors: 20,
      freeMemoryGiB: null,
      totalMemoryGiB: 31.73,
      gpus: normalizeImplausibleDiscreteVram(fixtureGpus)
    })

    expect(profile.id).toBe('parakeet-gpu')
  })

  it('classifies discrete GPU names without treating iGPUs as discrete', () => {
    expect(isLikelyDiscreteGpuName('Intel(R) Arc(TM) A370M Graphics', 'intel')).toBe(true)
    expect(isLikelyDiscreteGpuName('Intel(R) Arc(TM) B580 Graphics', 'intel')).toBe(true)
    expect(isLikelyDiscreteGpuName('Intel(R) Iris(R) Xe Graphics', 'intel')).toBe(false)
    expect(isLikelyDiscreteGpuName('Intel(R) UHD Graphics', 'intel')).toBe(false)
    expect(isLikelyDiscreteGpuName('Intel(R) HD Graphics 620', 'intel')).toBe(false)
    expect(isLikelyDiscreteGpuName('AMD Radeon RX 6600', 'amd')).toBe(true)
    expect(isLikelyDiscreteGpuName('AMD Radeon(TM) Graphics', 'amd')).toBe(false)
    expect(isLikelyDiscreteGpuName('NVIDIA GeForce RTX 4060 Laptop GPU', 'nvidia')).toBe(true)
    expect(isLikelyDiscreteGpuName('Duet Display', 'unknown')).toBe(false)
  })

  it('nulls implausible discrete VRAM but leaves integrated Intel readings alone', () => {
    const gpus = normalizeImplausibleDiscreteVram([
      { name: 'Intel(R) Arc(TM) A370M Graphics', vendor: 'intel', adapterRamGiB: 1 },
      { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 }
    ])

    expect(gpus[0].adapterRamGiB).toBeNull()
    expect(gpus[1].adapterRamGiB).toBe(1)
  })

  it('honors a forced faster-whisper-cpu override', () => {
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = 'faster-whisper-cpu'

    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'NVIDIA GeForce RTX 4090',
          vendor: 'nvidia',
          adapterRamGiB: 24
        }
      ]
    })

    expect(profile.id).toBe('faster-whisper-cpu')
  })

  it('allows an explicit whisper.cpp override for compatibility and tests', () => {
    process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND = 'whisper-cpp'

    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'NVIDIA GeForce RTX 4090',
          vendor: 'nvidia',
          adapterRamGiB: 24
        }
      ]
    })

    expect(profile.id).toBe('whisper-cpp')
  })

  it('selects whisper.cpp on non-Windows platforms', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      platform: 'darwin',
      arch: 'arm64',
      gpus: [
        {
          name: 'Apple M3 GPU',
          vendor: 'unknown',
          adapterRamGiB: 16
        }
      ]
    })

    expect(profile.id).toBe('whisper-cpp')
  })

  it('classifies common Windows GPU names', () => {
    expect(classifyWindowsGpuVendor('NVIDIA GeForce RTX 4050')).toBe('nvidia')
    expect(classifyWindowsGpuVendor('Intel(R) Arc(TM) Graphics')).toBe('intel')
    expect(classifyWindowsGpuVendor('AMD Radeon 780M Graphics')).toBe('amd')
    expect(classifyWindowsGpuVendor('Microsoft Basic Display Adapter')).toBe('unknown')
  })

  it('keeps English backend selection identical on every Windows hardware profile', () => {
    const cases: Array<{
      hardware: WindowsHardwareProfile
      backend: WindowsTranscriptionBackendId
    }> = [
      {
        hardware: {
          ...baseHardware,
          gpus: [{ name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vendor: 'nvidia', adapterRamGiB: 8 }]
        },
        backend: 'parakeet-gpu'
      },
      {
        hardware: {
          ...baseHardware,
          gpus: [{ name: 'AMD Radeon RX 6800', vendor: 'amd', adapterRamGiB: 8 }]
        },
        backend: 'parakeet-gpu'
      },
      {
        hardware: {
          ...baseHardware,
          totalMemoryGiB: 16,
          gpus: [{ name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: null }]
        },
        backend: 'parakeet-gpu'
      },
      {
        hardware: {
          ...baseHardware,
          gpus: []
        },
        backend: 'parakeet-cpu'
      },
      {
        hardware: {
          ...baseHardware,
          logicalProcessors: 4,
          totalMemoryGiB: 8,
          freeMemoryGiB: 3,
          gpus: []
        },
        backend: 'parakeet-cpu'
      }
    ]

    for (const { hardware, backend } of cases) {
      const profile = selectWindowsTranscriptionProfile(hardware)
      expect(profile.id).toBe(backend)
      expect(ENGLISH_WINDOWS_TRANSCRIPTION_BACKEND_IDS).toContain(profile.id)
      expect(profile).toBe(WINDOWS_TRANSCRIPTION_PROFILES[backend])
    }
  })

  it('keeps English profile assets, devices and readiness floors unchanged', () => {
    expect(CANARY_CUDA_MIN_VRAM_GIB).toBe(6)
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cuda']).toMatchObject({
      engine: 'faster-whisper',
      device: 'cuda',
      computeType: 'int8_float32',
      minVramGiB: 6,
      modelName: 'distil-large-v3',
      assets: [
        {
          filename: 'faster-whisper-runtime-cuda-win-x64.zip',
          sha256: '785d572be18d058882fd3256b8aec4bd249ddf77f3f392659372ddf08c85bf1a',
          bytes: 1439431425
        },
        {
          filename: 'faster-whisper-distil-large-v3-ct2.zip',
          sha256: '81ae0a2cc4dfe70370cb33129c191365e0c090dddb4924b077ee0ffad42b5064',
          bytes: 1397218990
        }
      ]
    })
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cpu']).toMatchObject({
      engine: 'faster-whisper',
      device: 'cpu',
      computeType: 'int8',
      modelName: 'small.en',
      assets: [
        {
          filename: 'faster-whisper-runtime-cpu-win-x64.zip',
          sha256: '63cc6240161372f9f45c2b218664a5cf3f7349530a7bdd9ed129849a90ff2ca9',
          bytes: 122910760
        },
        {
          filename: 'faster-whisper-small-en-ct2-int8.zip',
          sha256: '1347c7e02d8d70be7d5c7ed88729c29c9abc716f39322d62d6342b9a741bcaa8',
          bytes: 445198952
        }
      ]
    })
    expect(WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu']).toMatchObject({
      engine: 'parakeet',
      device: 'dml',
      computeType: 'fp32',
      minVramGiB: 4,
      modelName: 'parakeet-tdt-0.6b-v3',
      assets: [
        {
          filename: 'parakeet-runtime-win-x64.zip',
          sha256: 'e9a7e85dd29f6803a7ae976406c5cd33a49acb8296e1ec104d5aecd60cbcace3',
          bytes: 87511283
        },
        {
          filename: 'parakeet-tdt-0.6b-v3-fp32.zip',
          sha256: 'ea8bef61d8a6b47204b8062e450343547e393a8c70b696387c74eb4f3160ec23',
          bytes: 2370811633
        }
      ]
    })
    expect(WINDOWS_TRANSCRIPTION_PROFILES['parakeet-cpu']).toMatchObject({
      engine: 'parakeet',
      device: 'cpu',
      computeType: 'int8',
      modelName: 'parakeet-tdt-0.6b-v3',
      assets: [
        {
          filename: 'parakeet-runtime-win-x64.zip',
          sha256: 'e9a7e85dd29f6803a7ae976406c5cd33a49acb8296e1ec104d5aecd60cbcace3',
          bytes: 87511283
        },
        {
          filename: 'parakeet-tdt-0.6b-v3-int8.zip',
          sha256: '656335b7d7a4e1c6ecb3d78f2ac2ad342ae7865e34ec9d21905ea8c1a5e65733',
          bytes: 480454890
        }
      ]
    })
    expect(WINDOWS_TRANSCRIPTION_PROFILES['whisper-cpp'].assets).toEqual([])
  })

  it('adds multilingual profiles without changing English filenames or checksums', () => {
    expect(WINDOWS_TRANSCRIPTION_PROFILES['canary-cuda'].minVramGiB).toBe(CANARY_CUDA_MIN_VRAM_GIB)
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['canary-cuda'].assets.map((asset) => asset.filename)
    ).toEqual(['canary-cuda-runtime-win-x64.zip', 'canary-1b-v2-fp32.zip'])
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['canary-cpu'].assets.map((asset) => asset.filename)
    ).toEqual(['parakeet-runtime-win-x64.zip', 'canary-1b-v2-int8.zip'])
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cuda'].assets.map((asset) => asset.filename)
    ).toEqual(['faster-whisper-runtime-cuda-win-x64.zip', 'faster-whisper-large-v3-turbo-ct2.zip'])
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cpu'].assets.map((asset) => asset.filename)
    ).toEqual(['faster-whisper-runtime-cpu-win-x64.zip', 'faster-whisper-large-v3-turbo-ct2.zip'])
    expect(
      WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-vulkan'].assets.map((asset) => asset.filename)
    ).toEqual(['whisper-cpp-vulkan-runtime-win-x64.zip', 'ggml-large-v3-turbo.zip'])
    expect(WINDOWS_TRANSCRIPTION_PROFILES['canary-cuda'].assets[0].sha256).toBe(
      '4f6cd9d0dc4e213ffd940beb04af87ca591a41bafc9293b98535407a79ac730f'
    )
    expect(WINDOWS_TRANSCRIPTION_PROFILES['canary-cpu'].assets[1].bytes).toBe(727296090)
    expect(WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cuda'].assets[1].bytes).toBe(1492333094)
    expect(WINDOWS_TRANSCRIPTION_PROFILES['canary-cuda'].assets[1].expectedFiles).toContain(
      'encoder-model.onnx.data'
    )
    expect(WINDOWS_TRANSCRIPTION_PROFILES['whisper-turbo-cuda'].minVramGiB).toBe(
      WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cuda'].minVramGiB
    )
  })

  it('copies nvidia-smi driver versions onto the matched GPU', () => {
    const gpus = applyNvidiaSmiMemory(
      [{ name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vendor: 'nvidia', adapterRamGiB: 4 }],
      parseNvidiaSmiGpuRows('NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB, 581.95')
    )

    expect(gpus[0].driverVersion).toBe('581.95')
  })

  it('loads profile asset metadata from the public manifest', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-win-manifest-'))
    const manifestPath = join(rootDir, 'manifest.json')

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          releaseTag: 'test-release',
          profiles: [
            {
              id: 'faster-whisper-cpu',
              label: 'Test CPU backend',
              modelName: 'tiny.en',
              device: 'cpu',
              computeType: 'int8',
              minSystemMemoryGiB: 4,
              assets: [
                {
                  id: 'runtime',
                  filename: 'test-runtime.zip',
                  url: 'https://example.test/test-runtime.zip',
                  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  expectedFiles: ['python.exe'],
                  sources: ['test source'],
                  licenses: ['MIT']
                }
              ]
            }
          ]
        })
      )

      const profiles = await loadWindowsTranscriptionProfiles(manifestPath)
      expect(profiles['faster-whisper-cpu']).toMatchObject({
        label: 'Test CPU backend',
        modelName: 'tiny.en',
        engine: 'faster-whisper',
        assets: [
          {
            filename: 'test-runtime.zip',
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          }
        ]
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('accepts version 2 manifests with parakeet profiles and engine metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-win-manifest-v2-'))
    const manifestPath = join(rootDir, 'manifest.json')

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 2,
          releaseTag: 'test-release-v2',
          profiles: [
            {
              id: 'parakeet-cpu',
              label: 'Test Parakeet CPU',
              modelName: 'parakeet-tdt-0.6b-v3',
              engine: 'parakeet',
              device: 'cpu',
              computeType: 'int8',
              minSystemMemoryGiB: 8,
              estimatedMemoryGiB: 2,
              assets: [
                {
                  id: 'runtime',
                  filename: 'parakeet-runtime-win-x64.zip',
                  url: 'https://example.test/parakeet-runtime-win-x64.zip',
                  sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  expectedFiles: ['python.exe']
                }
              ]
            }
          ]
        })
      )

      const profiles = await loadWindowsTranscriptionProfiles(manifestPath)
      expect(profiles['parakeet-cpu']).toMatchObject({
        label: 'Test Parakeet CPU',
        engine: 'parakeet',
        assets: [
          {
            filename: 'parakeet-runtime-win-x64.zip',
            sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          }
        ]
      })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('can rewrite manifest asset URLs to a local validation server', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-win-manifest-base-url-'))
    const manifestPath = join(rootDir, 'manifest.json')

    try {
      process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = 'http://127.0.0.1:8765/assets/'
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          releaseTag: 'test-release',
          artifactBaseUrl: 'https://example.test/release',
          profiles: [
            {
              id: 'faster-whisper-cpu',
              label: 'Test CPU backend',
              modelName: 'tiny.en',
              device: 'cpu',
              computeType: 'int8',
              minSystemMemoryGiB: 4,
              assets: [
                {
                  id: 'runtime',
                  filename: 'test-runtime.zip',
                  url: 'https://example.test/test-runtime.zip',
                  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                  expectedFiles: ['python.exe'],
                  sources: ['test source'],
                  licenses: ['MIT']
                }
              ]
            }
          ]
        })
      )

      const profiles = await loadWindowsTranscriptionProfiles(manifestPath)
      expect(profiles['faster-whisper-cpu'].assets[0].url).toBe(
        'http://127.0.0.1:8765/assets/test-runtime.zip'
      )
    } finally {
      delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('rewrites multipart asset part URLs from artifactBaseUrl', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'autodoc-win-manifest-parts-'))
    const manifestPath = join(rootDir, 'manifest.json')

    try {
      process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL = 'http://127.0.0.1:8765/assets/'
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 2,
          releaseTag: 'test-release',
          artifactBaseUrl: 'https://example.test/release',
          profiles: [
            {
              id: 'parakeet-gpu',
              label: 'Test GPU backend',
              modelName: 'parakeet-tdt-0.6b-v3',
              device: 'dml',
              computeType: 'fp32',
              minSystemMemoryGiB: 8,
              assets: [
                {
                  id: 'model',
                  filename: 'parakeet-tdt-0.6b-v3-fp32.zip',
                  url: 'https://example.test/parakeet-tdt-0.6b-v3-fp32.zip',
                  sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                  bytes: 2370811633,
                  expectedFiles: ['encoder-model.onnx'],
                  parts: [
                    {
                      filename: 'parakeet-tdt-0.6b-v3-fp32.zip.part1',
                      url: 'https://example.test/parakeet-tdt-0.6b-v3-fp32.zip.part1',
                      sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                      bytes: 1185405817
                    },
                    {
                      filename: 'parakeet-tdt-0.6b-v3-fp32.zip.part2',
                      url: 'https://example.test/parakeet-tdt-0.6b-v3-fp32.zip.part2',
                      sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                      bytes: 1185405816
                    }
                  ]
                }
              ]
            }
          ]
        })
      )

      const profiles = await loadWindowsTranscriptionProfiles(manifestPath)
      const modelAsset = profiles['parakeet-gpu'].assets.find((asset) => asset.id === 'model')
      expect(modelAsset?.url).toBe('http://127.0.0.1:8765/assets/parakeet-tdt-0.6b-v3-fp32.zip')
      expect(modelAsset?.parts).toEqual([
        {
          filename: 'parakeet-tdt-0.6b-v3-fp32.zip.part1',
          url: 'http://127.0.0.1:8765/assets/parakeet-tdt-0.6b-v3-fp32.zip.part1',
          sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          bytes: 1185405817
        },
        {
          filename: 'parakeet-tdt-0.6b-v3-fp32.zip.part2',
          url: 'http://127.0.0.1:8765/assets/parakeet-tdt-0.6b-v3-fp32.zip.part2',
          sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          bytes: 1185405816
        }
      ])
    } finally {
      delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_ASSET_BASE_URL
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps fallback profile assets aligned with the shipped manifest', async () => {
    const raw = await readFile(
      join(process.cwd(), 'resources', 'windows-transcription-manifest.json'),
      'utf-8'
    )
    const manifest = JSON.parse(raw) as {
      profiles: Array<{
        id: keyof typeof WINDOWS_TRANSCRIPTION_PROFILES
        assets: Array<{
          filename: string
          sha256: string
          bytes?: number
          parts?: Array<{ filename: string; sha256: string; bytes: number }>
        }>
      }>
    }

    for (const profile of manifest.profiles) {
      const fallback = WINDOWS_TRANSCRIPTION_PROFILES[profile.id]
      expect(fallback.assets).toHaveLength(profile.assets.length)
      for (const [index, shipped] of profile.assets.entries()) {
        const asset = fallback.assets[index]
        expect(asset.filename).toBe(shipped.filename)
        expect(asset.sha256).toBe(shipped.sha256)
        expect(asset.bytes).toBe(shipped.bytes)
        expect(
          asset.parts?.map((part) => ({
            filename: part.filename,
            sha256: part.sha256,
            bytes: part.bytes
          }))
        ).toEqual(
          shipped.parts?.map((part) => ({
            filename: part.filename,
            sha256: part.sha256,
            bytes: part.bytes
          }))
        )
      }
    }
  })

  it('keeps English checksums when loading the shipped manifest', async () => {
    const profiles = await loadWindowsTranscriptionProfiles(
      join(process.cwd(), 'resources', 'windows-transcription-manifest.json')
    )

    expect(selectWindowsTranscriptionProfile(baseHardware, profiles).id).toBe('parakeet-cpu')
    expect(
      selectWindowsTranscriptionProfile(
        {
          ...baseHardware,
          gpus: [{ name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vendor: 'nvidia', adapterRamGiB: 8 }]
        },
        profiles
      ).id
    ).toBe('parakeet-gpu')
    expect(profiles['parakeet-gpu'].assets[0].sha256).toBe(
      'e9a7e85dd29f6803a7ae976406c5cd33a49acb8296e1ec104d5aecd60cbcace3'
    )
    expect(profiles['parakeet-gpu'].assets[1].sha256).toBe(
      'ea8bef61d8a6b47204b8062e450343547e393a8c70b696387c74eb4f3160ec23'
    )
    expect(profiles['faster-whisper-cuda'].assets[0].filename).toBe(
      'faster-whisper-runtime-cuda-win-x64.zip'
    )
    expect(profiles['canary-cuda'].assets[0].filename).toBe('canary-cuda-runtime-win-x64.zip')
    expect(profiles['canary-cuda'].minVramGiB).toBe(6)
  })
})
