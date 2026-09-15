import {
  ARM_A_CHUNK_NUM_CTX,
  ARM_A_CHUNK_NUM_PREDICT,
  ARM_A_COMBINE_NUM_CTX,
  ARM_A_COMBINE_NUM_PREDICT,
  ARM_A_NUM_CTX,
  ARM_A_NUM_PREDICT,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateOptions, GenerateRequest } from './ollama-client.ts'
import {
  armATemplates,
  fillTemplate,
  type ArmAPromptVersion
} from './prompts.ts'
import { estimateTokens } from './tokens.ts'
import type { TranscriptProjection } from './transcript-projection.ts'

export interface ArmACall {
  role: 'direct' | 'chunk-summary' | 'combine'
  templateName: string
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  request: Omit<GenerateRequest, 'model'>
}

export interface ArmAPlan {
  mode: 'single-call' | 'chunk-hierarchy'
  temperature: AllowedTemperature
  promptVersion: ArmAPromptVersion
  calls: ArmACall[]
}

function options(
  num_ctx: number,
  num_predict: number,
  temperature: AllowedTemperature,
  seed: number = DEFAULT_SEED
): GenerateOptions {
  return {
    num_ctx,
    num_predict,
    temperature,
    seed,
    stop: STOP_CONDITIONS
  }
}

function call(
  role: ArmACall['role'],
  templateName: string,
  template: string,
  prompt: string,
  generateOptions: GenerateOptions
): ArmACall {
  return {
    role,
    templateName,
    templateSha256: sha256Utf8(template),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    request: {
      prompt,
      stream: true,
      options: generateOptions
    }
  }
}

export function armAPromptTokensWithoutTranscript(promptVersion: ArmAPromptVersion = 1): number {
  const filled = fillTemplate(armATemplates(promptVersion).direct.text, {
    MEETING_TITLE: '',
    TRANSCRIPT: ''
  })
  return estimateTokens(filled)
}

export function planArmA(
  projection: TranscriptProjection,
  temperature: AllowedTemperature,
  promptVersion: ArmAPromptVersion = 1,
  seed: number = DEFAULT_SEED
): ArmAPlan {
  const templates = armATemplates(promptVersion)
  if (projection.stats.mode === 'single-call') {
    const prompt = fillTemplate(templates.direct.text, {
      MEETING_TITLE: projection.title,
      TRANSCRIPT: projection.text
    })
    return {
      mode: 'single-call',
      temperature,
      promptVersion,
      calls: [
        call(
          'direct',
          templates.direct.name,
          templates.direct.text,
          prompt,
          options(ARM_A_NUM_CTX, ARM_A_NUM_PREDICT, temperature, seed)
        )
      ]
    }
  }

  const chunkCalls = projection.chunks.map((chunk) => {
    const prompt = fillTemplate(templates.chunk.text, {
      CHUNK_INDEX: String(chunk.index),
      CHUNK_TOTAL: String(chunk.total),
      CHUNK_TEXT: chunk.text
    })
    return call(
      'chunk-summary',
      templates.chunk.name,
      templates.chunk.text,
      prompt,
      options(ARM_A_CHUNK_NUM_CTX, ARM_A_CHUNK_NUM_PREDICT, temperature, seed)
    )
  })

  return {
    mode: 'chunk-hierarchy',
    temperature,
    promptVersion,
    calls: chunkCalls
  }
}

export function planArmACombine(
  projection: TranscriptProjection,
  temperature: AllowedTemperature,
  summaries: readonly string[],
  promptVersion: ArmAPromptVersion = 1,
  seed: number = DEFAULT_SEED
): ArmACall {
  const templates = armATemplates(promptVersion)
  const numbered = summaries
    .map((summary, index) => `--- chunk ${index + 1} ---\n${summary.trim()}`)
    .join('\n\n')
  const prompt = fillTemplate(templates.combine.text, {
    MEETING_TITLE: projection.title,
    SUMMARIES: numbered
  })
  return call(
    'combine',
    templates.combine.name,
    templates.combine.text,
    prompt,
    options(ARM_A_COMBINE_NUM_CTX, ARM_A_COMBINE_NUM_PREDICT, temperature, seed)
  )
}
