import {
  ARM_C_NUM_CTX,
  ARM_C_NUM_PREDICT,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_C_TEMPLATE, fillTemplate } from './prompts.ts'
import { estimateTokens } from './tokens.ts'
import type { TranscriptProjection } from './transcript-projection.ts'

export interface ArmCPlan {
  mode: 'single-call'
  temperature: AllowedTemperature
  seed: number
  templateName: 'ARM_C_TEMPLATE'
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  request: Omit<GenerateRequest, 'model'>
}

export function armCPromptTokensWithoutTranscript(): number {
  const filled = fillTemplate(ARM_C_TEMPLATE, {
    MEETING_TITLE: '',
    TRANSCRIPT: ''
  })
  return estimateTokens(filled)
}

export function planArmC(
  projection: TranscriptProjection,
  temperature: AllowedTemperature,
  seed: number = DEFAULT_SEED
): ArmCPlan {
  if (projection.stats.mode !== 'single-call') {
    throw new Error('Arm C requires the transcript to fit in a single call')
  }
  const prompt = fillTemplate(ARM_C_TEMPLATE, {
    MEETING_TITLE: projection.title,
    TRANSCRIPT: projection.text
  })
  return {
    mode: 'single-call',
    temperature,
    seed,
    templateName: 'ARM_C_TEMPLATE',
    templateSha256: sha256Utf8(ARM_C_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    request: {
      prompt,
      stream: true,
      options: {
        num_ctx: ARM_C_NUM_CTX,
        num_predict: ARM_C_NUM_PREDICT,
        temperature,
        seed,
        stop: STOP_CONDITIONS
      }
    }
  }
}
