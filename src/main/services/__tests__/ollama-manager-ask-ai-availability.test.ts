import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OLLAMA_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL } from '../../../shared/constants'
import type { WindowsGpuInfo } from '../windows-transcription-runtime'

const originalPlatform = process.platform

async function load(platform: NodeJS.Platform, gpus: WindowsGpuInfo[] = []) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.resetModules()
  const detectWindowsHardwareProfile = vi.fn(async () => ({ gpus, totalMemoryGiB: 16 }))
  vi.doMock('electron', () => ({ app: { getPath: () => '/unused/profile', isPackaged: false } }))
  vi.doMock('../autodoc-log', () => ({ logAutodocEvent: vi.fn(), logAutodocFailure: vi.fn() }))
  vi.doMock('../windows-transcription-runtime', async (original) => ({
    ...(await original<typeof import('../windows-transcription-runtime')>()),
    detectWindowsHardwareProfile
  }))
  const { OllamaManager } = await import('../ollama-manager')
  return { OllamaManager, detectWindowsHardwareProfile }
}

const nvidia: WindowsGpuInfo = {
  name: 'NVIDIA GeForce RTX 4060',
  vendor: 'nvidia',
  adapterRamGiB: 8
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('electron')
  vi.doUnmock('../autodoc-log')
  vi.doUnmock('../windows-transcription-runtime')
  vi.resetModules()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('OllamaManager Ask AI availability', () => {
  it('is unknown, then available on a Mac with the default model, without a server', async () => {
    const { OllamaManager } = await load('darwin')
    const manager = new OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    const changes: boolean[] = []
    manager.on('ask-ai-availability', (available: boolean) => changes.push(available))
    expect(manager.getAskAiAvailability()).toBeNull()
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(true)
    expect(manager.getAskAiAvailability()).toBe(true)
    expect(changes).toEqual([true])
  })

  it('hides on a Mac whose profile model is the small one', async () => {
    const { OllamaManager } = await load('darwin')
    const manager = new OllamaManager({ resolveModel: async () => LOW_SPEC_MAC_OLLAMA_MODEL })
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(false)
    expect(manager.getAskAiAvailability()).toBe(false)
  })

  it('keeps Ask AI while the default model is still downloading and another one is active', async () => {
    const { OllamaManager } = await load('darwin')
    const manager = new OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    ;(manager as unknown as { askAiModel: string }).askAiModel = LOW_SPEC_MAC_OLLAMA_MODEL
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(true)
  })

  it('follows the Ollama accelerator on Windows, not the transcription device', async () => {
    const withGpu = await load('win32', [nvidia])
    const gpuManager = new withGpu.OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    await expect(gpuManager.resolveAskAiAvailability()).resolves.toBe(true)

    const noGpu = await load('win32', [])
    const cpuManager = new noGpu.OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    await expect(cpuManager.resolveAskAiAvailability()).resolves.toBe(false)

    const small = await load('win32', [nvidia])
    const smallManager = new small.OllamaManager({
      resolveModel: async () => LOW_SPEC_MAC_OLLAMA_MODEL
    })
    await expect(smallManager.resolveAskAiAvailability()).resolves.toBe(false)
  })

  it('resolves to hidden when detection fails', async () => {
    const { OllamaManager } = await load('darwin')
    const manager = new OllamaManager({
      resolveModel: async () => {
        throw new Error('profile unavailable')
      }
    })
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(false)
    expect(manager.getAskAiAvailability()).toBe(false)
  })

  it('turns off and notifies when the accelerator is latched to CPU', async () => {
    const { OllamaManager } = await load('win32', [nvidia])
    const manager = new OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    const changes: boolean[] = []
    manager.on('ask-ai-availability', (available: boolean) => changes.push(available))
    await manager.resolveAskAiAvailability()
    manager.latchCpuAccelerator('vulkan runner died')
    expect(manager.getAskAiAvailability()).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('stays hidden when the latch comes before the decision', async () => {
    const { OllamaManager } = await load('win32', [nvidia])
    const manager = new OllamaManager({ resolveModel: async () => DEFAULT_OLLAMA_MODEL })
    manager.latchCpuAccelerator('dev-only CPU notes validation')
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(false)
  })

  it('lets AUTODOC_ASK_AI_AVAILABLE override the rule without detecting hardware', async () => {
    const { OllamaManager, detectWindowsHardwareProfile } = await load('win32', [])
    const manager = new OllamaManager({ resolveModel: async () => LOW_SPEC_MAC_OLLAMA_MODEL })
    vi.stubEnv('AUTODOC_ASK_AI_AVAILABLE', '1')
    expect(manager.getAskAiAvailability()).toBe(true)
    await expect(manager.resolveAskAiAvailability()).resolves.toBe(true)
    vi.stubEnv('AUTODOC_ASK_AI_AVAILABLE', '0')
    expect(manager.getAskAiAvailability()).toBe(false)
    expect(detectWindowsHardwareProfile).not.toHaveBeenCalled()
  })
})

describe('Ask AI search model pull', () => {
  async function pullWith(platform: NodeJS.Platform, model: string, gpus: WindowsGpuInfo[]) {
    // The pull is skipped in test runtimes, so load the module as a packaged app would.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTODOC_TEST_MODE', '')
    const { OllamaManager } = await load(platform, gpus)
    const manager = new OllamaManager({ resolveModel: async () => model })
    const pull = vi.spyOn(manager, 'pullModel').mockResolvedValue(undefined)
    await (
      manager as unknown as { pullOptionalEmbeddingModel(epoch: number): Promise<void> }
    ).pullOptionalEmbeddingModel(manager.beginSetupLifecycle())
    return pull
  }

  it('downloads it where Ask AI is offered', async () => {
    expect(await pullWith('win32', DEFAULT_OLLAMA_MODEL, [nvidia])).toHaveBeenCalledTimes(1)
  })

  it('does not download it where Ask AI is hidden', async () => {
    expect(await pullWith('win32', DEFAULT_OLLAMA_MODEL, [])).not.toHaveBeenCalled()
    expect(await pullWith('darwin', LOW_SPEC_MAC_OLLAMA_MODEL, [])).not.toHaveBeenCalled()
  })
})
