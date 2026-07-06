import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyNvidiaSmiMemory,
  applyRegistryGpuMemory,
  classifyWindowsGpuVendor,
  electronMemoryKbToGiB,
  loadWindowsTranscriptionProfiles,
  parseNvidiaSmiGpuRows,
  parseWindowsRegistryGpuRows,
  selectWindowsTranscriptionProfile,
  shouldSerializeWindowsLocalProcessing,
  WINDOWS_TRANSCRIPTION_PROFILES,
  type WindowsHardwareProfile
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

  it('uses the public asset-only repository for fallback asset URLs', () => {
    expect(WINDOWS_TRANSCRIPTION_PROFILES['faster-whisper-cpu'].assets[0].url).toBe(
      'https://github.com/DuetDisplay/AutoDoc-Windows-Assets/releases/download/windows-transcription-v2/faster-whisper-runtime-cpu-win-x64.zip'
    )
    expect(WINDOWS_TRANSCRIPTION_PROFILES['parakeet-gpu'].assets[0].url).toBe(
      'https://github.com/DuetDisplay/AutoDoc-Windows-Assets/releases/download/windows-transcription-v2/parakeet-runtime-win-x64.zip'
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
})
