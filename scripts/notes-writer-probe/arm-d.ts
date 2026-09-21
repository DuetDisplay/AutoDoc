import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  ARM_D_NUM_CTX,
  ARM_D_NUM_PREDICT,
  DEFAULT_SEED,
  STOP_CONDITIONS,
  type AllowedTemperature
} from './constants.ts'
import { sha256Utf8 } from './hash.ts'
import type { GenerateRequest } from './ollama-client.ts'
import { ARM_D_TEMPLATE, fillTemplate } from './prompts.ts'
import { countWords, estimateTokens } from './tokens.ts'

export interface ArmDPlan {
  mode: 'single-call'
  temperature: AllowedTemperature
  seed: number
  templateName: 'ARM_D_TEMPLATE'
  templateSha256: string
  filledPromptSha256: string
  prompt: string
  notesCharCount: number
  notesWordCount: number
  notesEstimatedTokens: number
  commitmentsCharCount: number
  commitmentsWordCount: number
  commitmentsEstimatedTokens: number
  request: Omit<GenerateRequest, 'model'>
}

export async function loadArmDNotes(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath)
  const raw = await readFile(resolved, 'utf8')
  if (raw.trim().length === 0) {
    throw new Error('Arm D notes input is empty')
  }
  return raw
}

export async function loadArmDCommitments(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath)
  return readFile(resolved, 'utf8')
}

export function armDPromptTokensWithoutInputs(): number {
  const filled = fillTemplate(ARM_D_TEMPLATE, {
    NOTES: '',
    COMMITMENTS: ''
  })
  return estimateTokens(filled)
}

export function planArmD(
  notes: string,
  commitments: string,
  temperature: AllowedTemperature,
  seed: number = DEFAULT_SEED
): ArmDPlan {
  const prompt = fillTemplate(ARM_D_TEMPLATE, {
    NOTES: notes,
    COMMITMENTS: commitments.trim().length === 0 ? '(none)' : commitments
  })
  return {
    mode: 'single-call',
    temperature,
    seed,
    templateName: 'ARM_D_TEMPLATE',
    templateSha256: sha256Utf8(ARM_D_TEMPLATE),
    filledPromptSha256: sha256Utf8(prompt),
    prompt,
    notesCharCount: notes.length,
    notesWordCount: countWords(notes),
    notesEstimatedTokens: estimateTokens(notes),
    commitmentsCharCount: commitments.length,
    commitmentsWordCount: countWords(commitments),
    commitmentsEstimatedTokens: estimateTokens(commitments),
    request: {
      prompt,
      stream: true,
      options: {
        num_ctx: ARM_D_NUM_CTX,
        num_predict: ARM_D_NUM_PREDICT,
        temperature,
        seed,
        stop: STOP_CONDITIONS
      }
    }
  }
}
