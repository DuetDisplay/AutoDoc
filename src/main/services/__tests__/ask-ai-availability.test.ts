import { describe, expect, it } from 'vitest'
import { DEFAULT_OLLAMA_MODEL, LOW_SPEC_MAC_OLLAMA_MODEL } from '../../../shared/constants'
import { askAiAvailabilityOverride, isAskAiAvailable } from '../ask-ai-availability'
import type { OllamaAccelerator } from '../ollama-accelerator'

describe('isAskAiAvailable', () => {
  const cases: Array<[string, string, OllamaAccelerator, boolean | undefined, boolean]> = [
    ['Mac Qwen on Metal', DEFAULT_OLLAMA_MODEL, 'metal', undefined, true],
    ['Mac llama3.2:3b (8 GB)', LOW_SPEC_MAC_OLLAMA_MODEL, 'metal', undefined, false],
    ['Windows Qwen on CUDA', DEFAULT_OLLAMA_MODEL, 'cuda', undefined, true],
    ['Windows llama3.2:3b on CUDA (8 GB)', LOW_SPEC_MAC_OLLAMA_MODEL, 'cuda', undefined, false],
    ['Windows Qwen on CPU', DEFAULT_OLLAMA_MODEL, 'cpu', undefined, false],
    ['Windows Qwen on Vulkan', DEFAULT_OLLAMA_MODEL, 'vulkan', undefined, true],
    ['override 0 on a capable machine', DEFAULT_OLLAMA_MODEL, 'cuda', false, false],
    ['override 1 on CPU', LOW_SPEC_MAC_OLLAMA_MODEL, 'cpu', true, true]
  ]
  it.each(cases)('%s', (_name, profileModel, accelerator, override, expected) => {
    expect(isAskAiAvailable({ profileModel, accelerator, override })).toBe(expected)
  })
})

describe('askAiAvailabilityOverride', () => {
  it('only 0 and 1 override the rule', () => {
    expect(askAiAvailabilityOverride({ AUTODOC_ASK_AI_AVAILABLE: '0' })).toBe(false)
    expect(askAiAvailabilityOverride({ AUTODOC_ASK_AI_AVAILABLE: '1' })).toBe(true)
    expect(askAiAvailabilityOverride({ AUTODOC_ASK_AI_AVAILABLE: 'yes' })).toBeNull()
    expect(askAiAvailabilityOverride({})).toBeNull()
  })
})
