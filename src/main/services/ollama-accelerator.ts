import { isLikelyDiscreteGpuName, type WindowsGpuInfo } from './windows-transcription-runtime'

export type OllamaAccelerator = 'cuda' | 'vulkan' | 'metal' | 'cpu'

/** Mid-writer recycle is a Metal/GPU win. On Windows CPU it killed in-flight notes. */
export function shouldRecycleRunnerBetweenWriterChunks(
  platform: NodeJS.Platform,
  accelerator: OllamaAccelerator
): boolean {
  return !(platform === 'win32' && accelerator === 'cpu')
}

export interface OllamaAcceleratorDecision {
  accelerator: OllamaAccelerator
  env: Record<string, string>
  reason: string
}

export function selectOllamaAccelerator(input: {
  platform: NodeJS.Platform
  gpus: readonly WindowsGpuInfo[]
  totalMemoryGiB: number | null
  vulkanOverride?: string
}): OllamaAcceleratorDecision {
  if (input.platform === 'darwin') {
    return {
      accelerator: 'metal',
      env: {},
      reason: 'macOS uses Metal natively'
    }
  }

  const nvidiaGpu = input.gpus.find((gpu) => gpu.vendor === 'nvidia')
  const vulkanCandidate = findVulkanCapableGpu(input.gpus)
  // Without the kill switch: NVIDIA → CUDA, override 1 → Vulkan, else discrete Intel/AMD.
  const wouldChooseVulkan =
    nvidiaGpu == null && (input.vulkanOverride === '1' || vulkanCandidate != null)

  if (input.vulkanOverride === '0' && wouldChooseVulkan) {
    // Ollama >= 0.30 enables Vulkan by default, so disabling requires an
    // explicit 0 — omitting the variable is not enough.
    return {
      accelerator: 'cpu',
      env: { OLLAMA_VULKAN: '0' },
      reason: vulkanCandidate
        ? `AUTODOC_OLLAMA_VULKAN=0 override disabled Vulkan for ${vulkanCandidate.name}`
        : 'AUTODOC_OLLAMA_VULKAN=0 override disabled Vulkan'
    }
  }

  if (nvidiaGpu) {
    // Default-on Vulkan (Ollama >= 0.30) can misclassify a shared-memory iGPU
    // as discrete and schedule the model there instead of the NVIDIA card
    // (measured 18 tok/s on an Iris Xe vs 58 tok/s on the RTX 4060 beside it),
    // so CUDA machines must disable Vulkan discovery outright.
    return {
      accelerator: 'cuda',
      env: { OLLAMA_VULKAN: '0' },
      reason: `NVIDIA GPU detected (${nvidiaGpu.name}); using native CUDA with Vulkan disabled`
    }
  }

  if (input.vulkanOverride === '1') {
    return {
      accelerator: 'vulkan',
      env: { OLLAMA_VULKAN: '1' },
      reason: 'AUTODOC_OLLAMA_VULKAN=1 override forced Vulkan'
    }
  }

  if (vulkanCandidate) {
    return {
      accelerator: 'vulkan',
      env: { OLLAMA_VULKAN: '1' },
      reason: `discrete ${vulkanCandidate.vendor} GPU (${vulkanCandidate.name}) qualifies for Vulkan`
    }
  }

  return {
    accelerator: 'cpu',
    env: { OLLAMA_VULKAN: '0' },
    reason: 'no CUDA or Vulkan-capable GPU detected'
  }
}

const VULKAN_MIN_KNOWN_VRAM_GIB = 8

function findVulkanCapableGpu(gpus: readonly WindowsGpuInfo[]): WindowsGpuInfo | undefined {
  return gpus.find((gpu) => {
    if (gpu.vendor !== 'intel' && gpu.vendor !== 'amd') {
      return false
    }
    if (!isLikelyDiscreteGpuName(gpu.name, gpu.vendor)) {
      return false
    }
    // Unknown VRAM is CPU. 4 GB Arc cards split-offload and crash; require a
    // known adapter RAM of at least 8 GiB (RX 6600 / A770 class).
    return gpu.adapterRamGiB != null && gpu.adapterRamGiB >= VULKAN_MIN_KNOWN_VRAM_GIB
  })
}
