import { LOW_SPEC_MAC_OLLAMA_MODEL } from '../../shared/constants'

/** Normal Ask AI defaults. Individual overrides and one rollback switch remain
 * available for diagnosis; users do not need environment setup for these fixes. */
export function askAiOption(name: string, optimized: string, legacy: string): string {
  return process.env[name] ?? (process.env.AUTODOC_ASK_AI_OPTIMIZED === '0' ? legacy : optimized)
}

export function useAskAiPassages(): boolean {
  return !['', '0', 'off'].includes(askAiOption('AUTODOC_ASK_AI_PASSAGES', 'both', '0'))
}

export function useAskAiGenerationPriority(): boolean {
  return askAiOption('AUTODOC_ASK_AI_GENERATION_PRIORITY', '1', '0') === '1'
}

export function wantsDetailedAskAiAnswer(question: string): boolean {
  return /\b(?:in detail|detailed|comprehensive|all|every)\b|詳しく|詳細|détaill|ausführlich/iu.test(
    question
  )
}

export function askAiRuntimeDefaults(accelerator: string): Record<string, string> {
  if (process.env.AUTODOC_ASK_AI_OPTIMIZED === '0') return {}
  return {
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? '1',
    ...(accelerator === 'cuda'
      ? { OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? '1' }
      : {})
  }
}

// Denylist of measured models, so unknown and test models keep native tools. Ollama's llama3.2
// chat template appends "respond with a JSON for a function call" to the last user turn whenever
// `tools` are present, so llama3.2:3b called a tool on 10/10 conversation questions (including
// 5/5 plain lookups), with schema-valid arguments on only 2/10. With tools off it gave 0 wrong
// answers on a 15-question set. qwen3:4b-instruct uses tools correctly.
export function askAiWriterToolsSupported(model: string): boolean {
  return model !== LOW_SPEC_MAC_OLLAMA_MODEL
}
