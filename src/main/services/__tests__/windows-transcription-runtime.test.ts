import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  classifyWindowsGpuVendor,
  loadWindowsTranscriptionProfiles,
  selectWindowsTranscriptionProfile,
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
  delete process.env.AUTODOC_WINDOWS_TRANSCRIPTION_BACKEND
})

describe('Windows transcription runtime selection', () => {
  it('selects CUDA faster-whisper for supported NVIDIA systems', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
          vendor: 'nvidia',
          adapterRamGiB: 6
        }
      ]
    })

    expect(profile.id).toBe('faster-whisper-cuda')
    expect(profile.assets.map((asset) => asset.filename)).toEqual([
      'faster-whisper-runtime-cuda-win-x64.zip',
      'faster-whisper-distil-large-v3-ct2.zip'
    ])
  })

  it('selects CPU faster-whisper when NVIDIA is unavailable', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'Intel Iris Xe Graphics',
          vendor: 'intel',
          adapterRamGiB: null
        }
      ]
    })

    expect(profile.id).toBe('faster-whisper-cpu')
    expect(profile.assets.map((asset) => asset.filename)).toEqual([
      'faster-whisper-runtime-cpu-win-x64.zip',
      'faster-whisper-small-en-ct2-int8.zip'
    ])
  })

  it('falls back to CPU faster-whisper when NVIDIA VRAM is below the CUDA floor', () => {
    const profile = selectWindowsTranscriptionProfile({
      ...baseHardware,
      gpus: [
        {
          name: 'NVIDIA GeForce GTX 1650',
          vendor: 'nvidia',
          adapterRamGiB: 4
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
})
