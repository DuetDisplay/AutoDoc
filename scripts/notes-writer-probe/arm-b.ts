import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  ARM_B_NUM_CTX,
  ARM_B_NUM_PREDICT,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_B_TEMPLATE, fillTemplate } from './prompts.ts'
import { countWords, estimateTokens } from './tokens.ts'

export interface ArmBPlan {
  mode: 'single-call'
  temperature: AllowedTemperature
  inputCharCount: number
  inputWordCount: number
  inputEstimatedTokens: number
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  request: Omit<GenerateRequest, 'model'>
}

export async function loadArmBInput(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath)
  const raw = await readFile(resolved, 'utf8')
  if (resolved.endsWith('.json')) {
    const parsed = JSON.parse(raw) as { markdown?: unknown }
    if (typeof parsed.markdown !== 'string' || parsed.markdown.trim().length === 0) {
      throw new Error('Arm B JSON input is missing a markdown field')
    }
    return parsed.markdown
  }
  if (raw.trim().length === 0) {
    throw new Error('Arm B markdown input is empty')
  }
  return raw
}

export function planArmB(notes: string, temperature: AllowedTemperature): ArmBPlan {
  const prompt = fillTemplate(ARM_B_TEMPLATE, { NOTES: notes })
  return {
    mode: 'single-call',
    temperature,
    inputCharCount: notes.length,
    inputWordCount: countWords(notes),
    inputEstimatedTokens: estimateTokens(notes),
    templateSha256: sha256Utf8(ARM_B_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    request: {
      prompt,
      stream: true,
      options: {
        num_ctx: ARM_B_NUM_CTX,
        num_predict: ARM_B_NUM_PREDICT,
        temperature,
        seed: DEFAULT_SEED,
        stop: STOP_CONDITIONS
      }
    }
  }
}
