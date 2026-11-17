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
  return /\b(?:in detail|detailed|comprehensive|all|every)\b|詳しく|詳細|détaill|ausführlich/iu.test(question)
}

export function askAiRuntimeDefaults(accelerator: string): Record<string, string> {
  if (process.env.AUTODOC_ASK_AI_OPTIMIZED === '0') return {}
  return {
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? '1',
    ...(accelerator === 'cuda' ? { OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? '1' } : {})
  }
}
