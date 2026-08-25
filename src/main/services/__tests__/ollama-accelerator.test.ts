import { describe, expect, it } from 'vitest'
import { selectOllamaAccelerator } from '../ollama-accelerator'
import {
  normalizeImplausibleDiscreteVram,
  type WindowsGpuInfo
} from '../windows-transcription-runtime'

const A370M_FIXTURE: WindowsGpuInfo[] = [
  { name: 'Intel(R) Arc(TM) A370M Graphics', vendor: 'intel', adapterRamGiB: 1 },
  { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 },
  { name: 'Duet Display', vendor: 'unknown', adapterRamGiB: null },
  { name: 'Duet Display', vendor: 'unknown', adapterRamGiB: null }
]

describe('selectOllamaAccelerator', () => {
  it('selects Metal on macOS', () => {
    expect(
      selectOllamaAccelerator({
        platform: 'darwin',
        gpus: [{ name: 'Apple M3 GPU', vendor: 'unknown', adapterRamGiB: 16 }],
        totalMemoryGiB: 24,
        vulkanOverride: '1'
      })
    ).toEqual({
      accelerator: 'metal',
      env: {},
      reason: 'macOS uses Metal natively'
    })
  })

  it('selects CUDA for NVIDIA and disables default-on Vulkan discovery', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [{ name: 'NVIDIA GeForce RTX 4060 Laptop GPU', vendor: 'nvidia', adapterRamGiB: 8 }],
      totalMemoryGiB: 16
    })

    expect(decision.accelerator).toBe('cuda')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '0' })
    expect(decision.reason).toContain('NVIDIA')
  })

  it('prefers CUDA over a Vulkan override when an NVIDIA GPU is present', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [
        { name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', adapterRamGiB: 8 },
        { name: 'Intel(R) Arc(TM) A370M Graphics', vendor: 'intel', adapterRamGiB: 4 }
      ],
      totalMemoryGiB: 32,
      vulkanOverride: '1'
    })

    expect(decision.accelerator).toBe('cuda')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '0' })
  })

  it('still selects CUDA when the Vulkan kill switch is set', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', adapterRamGiB: 8 }],
      totalMemoryGiB: 32,
      vulkanOverride: '0'
    })

    expect(decision.accelerator).toBe('cuda')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '0' })
  })

  it('forces Vulkan when AUTODOC_OLLAMA_VULKAN=1 and no NVIDIA GPU is present', () => {
    expect(
      selectOllamaAccelerator({
        platform: 'win32',
        gpus: [{ name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 }],
        totalMemoryGiB: 8,
        vulkanOverride: '1'
      })
    ).toEqual({
      accelerator: 'vulkan',
      env: { OLLAMA_VULKAN: '1' },
      reason: 'AUTODOC_OLLAMA_VULKAN=1 override forced Vulkan'
    })
  })

  it('falls back to CPU when the Vulkan kill switch blocks a qualifying Intel GPU', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: normalizeImplausibleDiscreteVram(A370M_FIXTURE),
      totalMemoryGiB: 31.73,
      vulkanOverride: '0'
    })

    expect(decision.accelerator).toBe('cpu')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '0' })
    expect(decision.reason).toMatch(/AUTODOC_OLLAMA_VULKAN=0/)
  })

  it('selects Vulkan for a discrete Intel GPU with enough reported VRAM', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [{ name: 'Intel(R) Arc(TM) A770 Graphics', vendor: 'intel', adapterRamGiB: 16 }],
      totalMemoryGiB: 16
    })

    expect(decision.accelerator).toBe('vulkan')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '1' })
    expect(decision.reason).toContain('A770')
  })

  it('selects Vulkan for Arc A370M after implausible 1 GiB VRAM is treated as unknown', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: normalizeImplausibleDiscreteVram(A370M_FIXTURE),
      totalMemoryGiB: 31.73
    })

    expect(decision.accelerator).toBe('vulkan')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '1' })
    expect(decision.reason).toContain('A370M')
  })

  it('selects Vulkan for a discrete AMD RX GPU with enough VRAM', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [{ name: 'AMD Radeon RX 6600', vendor: 'amd', adapterRamGiB: 8 }],
      totalMemoryGiB: 16
    })

    expect(decision.accelerator).toBe('vulkan')
    expect(decision.env).toEqual({ OLLAMA_VULKAN: '1' })
    expect(decision.reason).toContain('RX 6600')
  })

  it('does not select Vulkan for an AMD APU or Intel iGPU', () => {
    expect(
      selectOllamaAccelerator({
        platform: 'win32',
        gpus: [{ name: 'AMD Radeon(TM) Graphics', vendor: 'amd', adapterRamGiB: null }],
        totalMemoryGiB: 32
      }).accelerator
    ).toBe('cpu')

    expect(
      selectOllamaAccelerator({
        platform: 'win32',
        gpus: [{ name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', adapterRamGiB: 1 }],
        totalMemoryGiB: 32
      }).accelerator
    ).toBe('cpu')
  })

  it('does not select Vulkan when discrete VRAM is known and below 4 GiB', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [{ name: 'Intel(R) Arc(TM) A370M Graphics', vendor: 'intel', adapterRamGiB: 1 }],
      totalMemoryGiB: 31.73
    })

    expect(decision.accelerator).toBe('cpu')
  })

  it('selects CPU when no qualifying GPU is present', () => {
    const decision = selectOllamaAccelerator({
      platform: 'win32',
      gpus: [],
      totalMemoryGiB: 32
    })

    expect(decision.accelerator).toBe('cpu')
    expect(decision.env).toEqual({})
  })
})
