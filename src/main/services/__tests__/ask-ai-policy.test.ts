import { afterEach, expect, it, vi } from 'vitest'
import { askAiOption, useAskAiPassages, useAskAiGenerationPriority, askAiRuntimeDefaults } from '../ask-ai-policy'
afterEach(() => vi.unstubAllEnvs())
it('enables the verified retrieval, writer and priority path without experiment flags', () => {
  for (const key of [
    'AUTODOC_ASK_AI_OPTIMIZED',
    'AUTODOC_ASK_AI_PASSAGES',
    'AUTODOC_ASK_AI_GENERATION_PRIORITY',
    'AUTODOC_ASK_AI_WRITER_PROMPT'
  ])
    vi.stubEnv(key, undefined)
  expect(useAskAiPassages()).toBe(true)
  expect(useAskAiGenerationPriority()).toBe(true)
  expect(askAiOption('AUTODOC_ASK_AI_WRITER_PROMPT', 'focused-stable', 'baseline')).toBe(
    'focused-stable'
  )
})
it('keeps explicit rollback and per-feature controls', () => {
  vi.stubEnv('AUTODOC_ASK_AI_OPTIMIZED', '0')
  expect(useAskAiPassages()).toBe(false)
  expect(useAskAiGenerationPriority()).toBe(false)
  vi.stubEnv('AUTODOC_ASK_AI_PASSAGES', 'both')
  expect(useAskAiPassages()).toBe(true)
  vi.stubEnv('AUTODOC_ASK_AI_PASSAGES', '0')
  expect(useAskAiPassages()).toBe(false)
})
it('bounds normal runtime concurrency and enables tested CUDA attention only, respecting overrides', () => {
  vi.stubEnv('AUTODOC_ASK_AI_OPTIMIZED', undefined)
  vi.stubEnv('OLLAMA_NUM_PARALLEL', undefined)
  vi.stubEnv('OLLAMA_FLASH_ATTENTION', undefined)
  expect(askAiRuntimeDefaults('cuda')).toEqual({ OLLAMA_NUM_PARALLEL: '1', OLLAMA_FLASH_ATTENTION: '1' })
  expect(askAiRuntimeDefaults('cpu')).toEqual({ OLLAMA_NUM_PARALLEL: '1' })
  expect(askAiRuntimeDefaults('metal')).toEqual({ OLLAMA_NUM_PARALLEL: '1' })
  vi.stubEnv('OLLAMA_NUM_PARALLEL', '2')
  vi.stubEnv('OLLAMA_FLASH_ATTENTION', '0')
  expect(askAiRuntimeDefaults('cuda')).toEqual({ OLLAMA_NUM_PARALLEL: '2', OLLAMA_FLASH_ATTENTION: '0' })
})
