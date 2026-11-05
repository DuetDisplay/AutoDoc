import { DEFAULT_OLLAMA_MODEL } from '../../shared/constants'
import type { OllamaAccelerator } from './ollama-accelerator'

/**
 * AUTODOC_ASK_AI_AVAILABLE=0 hides Ask AI and =1 shows it, for tests, diagnosis and the
 * evaluation harnesses. Anything else leaves the hardware rule in charge.
 */
export function askAiAvailabilityOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const value = env.AUTODOC_ASK_AI_AVAILABLE
  return value === '1' ? true : value === '0' ? false : null
}

/**
 * Ask AI is offered only where the profile model is the default one and the model runs on
 * a GPU. Small-model answers and CPU answers (46 s to 138 s measured) are too poor to ship.
 * The model is the stable profile model, not the temporarily active one, and the accelerator
 * is the Ollama one, not the transcription device.
 */
export function isAskAiAvailable(input: {
  profileModel: string
  accelerator: OllamaAccelerator
  override?: boolean | null
}): boolean {
  if (input.override != null) return input.override
  return (
    input.profileModel === DEFAULT_OLLAMA_MODEL &&
    (input.accelerator === 'metal' ||
      input.accelerator === 'cuda' ||
      input.accelerator === 'vulkan')
  )
}
