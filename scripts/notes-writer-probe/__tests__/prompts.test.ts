import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sha256Utf8 } from '../hash.ts'
import {
  ARM_A_CHUNK_SUMMARY_TEMPLATE_V2,
  ARM_A_CHUNK_SUMMARY_TEMPLATE_V3,
  ARM_A_COMBINE_TEMPLATE_V2,
  ARM_A_COMBINE_TEMPLATE_V3,
  ARM_A_DIRECT_TEMPLATE,
  ARM_A_DIRECT_TEMPLATE_V2,
  ARM_A_DIRECT_TEMPLATE_V3,
  ARM_A_V1_TO_V2_PROMPT_DIFF,
  ARM_A_V2_TO_V3_PROMPT_DIFF,
  ARM_B_TASK_VERBATIM,
  ARM_B_TEMPLATE,
  ARM_C_TEMPLATE,
  ARM_D_TEMPLATE,
  ARM_E_GROUP_TEMPLATE,
  ARM_E_RESTYLE_TEMPLATE,
  ARM_F_COMPRESS_TEMPLATE,
  ARM_F_COMPRESS_TEMPLATE_V2,
  fillTemplate
} from '../prompts.ts'
import { promptPackSha256, promptTemplateRecords } from '../manifest.ts'

const frozen = {
  ARM_A_DIRECT_TEMPLATE: 'a7d921035375a64bf054d7777d96c63e796c60011add3b981c61e60b7a2c70e1',
  ARM_A_CHUNK_SUMMARY_TEMPLATE: '2deb40af861efccf09c3715fb1011d8ef7b8a0f50efd0d2ea987c2eee5057034',
  ARM_A_COMBINE_TEMPLATE: 'aa3120cc97f7bb6e2b9a1e4c470ab4e2a4f7dfe010b039a8408b1c04074e5fb0',
  ARM_B_TASK_VERBATIM: 'cbe088ea5deefb5d43a6afed6531b4621545721c6fa2bbf2fe91a757b344b80a',
  ARM_B_TEMPLATE: '9dfc9852d8f9e4bff169adc5e9b8a6aa2e820f6f58f927aa270855984a3707a7',
  pack: 'a7333b6d6f54daca5aa487326b400c10ec6a692b6cb79d71a69b4ff014f19723'
} as const

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('prompt templates', () => {
  it('hashes are stable and match the exported strings', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(digest(ARM_A_DIRECT_TEMPLATE))
    expect(sha256Utf8(ARM_B_TEMPLATE)).toBe(digest(ARM_B_TEMPLATE))
    const records = Object.fromEntries(
      promptTemplateRecords().map((item) => [item.name, item.sha256])
    )
    expect(records.ARM_A_DIRECT_TEMPLATE).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(records.ARM_A_CHUNK_SUMMARY_TEMPLATE).toBe(frozen.ARM_A_CHUNK_SUMMARY_TEMPLATE)
    expect(records.ARM_A_COMBINE_TEMPLATE).toBe(frozen.ARM_A_COMBINE_TEMPLATE)
    expect(records.ARM_B_TASK_VERBATIM).toBe(frozen.ARM_B_TASK_VERBATIM)
    expect(records.ARM_B_TEMPLATE).toBe(frozen.ARM_B_TEMPLATE)
    expect(promptPackSha256()).toBe(frozen.pack)
    expect(promptPackSha256(1)).toBe(frozen.pack)
  })

  it('v2 Arm A templates keep v1 guardrails and add the two editorial changes', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE_V2)).not.toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    const guardrails = [
      'Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.',
      'Do not invent work.',
      'Omit any section that would be empty. Do not emit placeholder headings.',
      'If the owner is not stated, omit the owner suffix entirely. Never write `null`. Never invent a name, owner, date, number, or deadline.',
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.',
      'Do not change tentative language into definite language.',
      'Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.'
    ]
    for (const line of guardrails) {
      expect(ARM_A_DIRECT_TEMPLATE_V2).toContain(line)
      expect(ARM_A_COMBINE_TEMPLATE_V2).toContain(
        line.includes('not in the transcript')
          ? 'Do not add any fact, name, number, owner, date, or causal claim that is not in the summaries.'
          : line
      )
    }
    expect(ARM_A_DIRECT_TEMPLATE_V2).toContain(
      'Each primary bullet must carry the concrete specifics actually said'
    )
    expect(ARM_A_DIRECT_TEMPLATE_V2).toContain('Brevity must never drop a commitment.')
    expect(ARM_A_DIRECT_TEMPLATE_V2).toContain('Do not pad with filler.')
    expect(ARM_A_CHUNK_SUMMARY_TEMPLATE_V2).toContain(
      'Do not add anything that is not in this chunk. Do not include timestamps, evidence IDs, or citations.'
    )
    const v2Names = promptTemplateRecords(2).map((item) => item.name)
    expect(v2Names).toEqual([
      'ARM_A_DIRECT_TEMPLATE_V2',
      'ARM_A_CHUNK_SUMMARY_TEMPLATE_V2',
      'ARM_A_COMBINE_TEMPLATE_V2'
    ])
    expect(promptPackSha256(2)).toHaveLength(64)
    expect(promptPackSha256(2)).not.toBe(frozen.pack)
    expect(ARM_A_V1_TO_V2_PROMPT_DIFF.summary).toHaveLength(3)
  })

  it('v3 Arm A templates keep guardrails, restore nesting, and end with the output skeleton', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE_V2)).toBe(
      '555b322ede9ffb977bbacfaa8a4e8f19d8c62f8393f762012281f7bc6f65e904'
    )
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE_V3)).not.toBe(sha256Utf8(ARM_A_DIRECT_TEMPLATE_V2))
    const nesting =
      'Under each heading, write concise primary bullets. Put supporting detail as nested sub-bullets under the point they support.'
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain(nesting)
    expect(ARM_A_COMBINE_TEMPLATE_V3).toContain(nesting)
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain('Do not flatten supporting detail')
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain('## Next Steps" is required')
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain('Required output shape')
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.'
    )
    expect(ARM_A_DIRECT_TEMPLATE_V3).toContain('Do not change tentative language into definite language.')
    expect(ARM_A_DIRECT_TEMPLATE_V3.indexOf('Required output shape')).toBeGreaterThan(
      ARM_A_DIRECT_TEMPLATE_V3.indexOf('Editorial rules:')
    )
    expect(ARM_A_DIRECT_TEMPLATE_V3.indexOf('Transcript:')).toBeGreaterThan(
      ARM_A_DIRECT_TEMPLATE_V3.indexOf('Required output shape')
    )
    expect(ARM_A_CHUNK_SUMMARY_TEMPLATE_V3).toContain(
      'Do not add anything that is not in this chunk. Do not include timestamps, evidence IDs, or citations.'
    )
    expect(promptTemplateRecords(3).map((item) => item.name)).toEqual([
      'ARM_A_DIRECT_TEMPLATE_V3',
      'ARM_A_CHUNK_SUMMARY_TEMPLATE_V3',
      'ARM_A_COMBINE_TEMPLATE_V3'
    ])
    expect(promptPackSha256(3)).toHaveLength(64)
    expect(promptPackSha256(3)).not.toBe(promptPackSha256(2))
    expect(ARM_A_V2_TO_V3_PROMPT_DIFF.summary).toHaveLength(4)
  })

  it('Arm B template starts with the plan §3.3 paragraph verbatim', () => {
    expect(ARM_B_TEMPLATE.startsWith(ARM_B_TASK_VERBATIM)).toBe(true)
    expect(ARM_B_TASK_VERBATIM).toContain('roughly half the length')
    expect(ARM_B_TASK_VERBATIM).toContain('Do not change tentative language into definite language')
  })

  it('Arm C extractor keeps Arm A guardrails and the commitment-only format', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(sha256Utf8(ARM_B_TEMPLATE)).toBe(frozen.ARM_B_TEMPLATE)
    const guardrails = [
      'Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.',
      'Do not invent work.',
      'If the owner is not stated, omit the owner suffix entirely. Never write `null`. Never invent a name, owner, date, number, or deadline.',
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.',
      'Do not change tentative language into definite language.',
      'Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.'
    ]
    for (const line of guardrails) {
      expect(ARM_C_TEMPLATE).toContain(line)
    }
    expect(ARM_C_TEMPLATE).toContain('Bold the action.')
    expect(ARM_C_TEMPLATE).toContain('`(Owner)`')
    expect(ARM_C_TEMPLATE).toContain('Never promote tentative, maybe, or should-consider language into commitments.')
    expect(promptTemplateRecords(1, 'c').map((item) => item.name)).toEqual(['ARM_C_TEMPLATE'])
    expect(sha256Utf8(ARM_C_TEMPLATE)).toBe(
      'ff22d7df86c4d74935b751ab1cac0c6dff86747804a94f6c726e90f01f091c91'
    )
    expect(promptPackSha256(1, 'c')).toHaveLength(64)
    expect(promptPackSha256(1, 'c')).not.toBe(frozen.pack)
  })

  it('Arm D restyle template keeps Arm A guardrails and ends with the output skeleton', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(sha256Utf8(ARM_B_TEMPLATE)).toBe(frozen.ARM_B_TEMPLATE)
    expect(sha256Utf8(ARM_C_TEMPLATE)).toBe(
      'ff22d7df86c4d74935b751ab1cac0c6dff86747804a94f6c726e90f01f091c91'
    )
    const guardrails = [
      'Do not promote questions, proposals, or "we should / maybe / could" language into Decisions.',
      'Do not invent work.',
      'Omit any section that would be empty. Do not emit placeholder headings.',
      'If the owner is not stated, omit the owner suffix entirely. Never write `null`. Never invent a name, owner, date, number, or deadline.',
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the input.',
      'Do not change tentative language into definite language.',
      'Do not include timestamps, evidence IDs, citations, or speaker labels in the notes.'
    ]
    for (const line of guardrails) {
      expect(ARM_D_TEMPLATE).toContain(line)
    }
    expect(ARM_D_TEMPLATE).toContain('Do not compress.')
    expect(ARM_D_TEMPLATE).toContain('`(Owner)`')
    expect(ARM_D_TEMPLATE).toContain('Required output shape')
    expect(ARM_D_TEMPLATE.indexOf('Required output shape')).toBeGreaterThan(
      ARM_D_TEMPLATE.indexOf('Editorial rules:')
    )
    expect(ARM_D_TEMPLATE.indexOf('Meeting notes:')).toBeGreaterThan(
      ARM_D_TEMPLATE.indexOf('Required output shape')
    )
    expect(ARM_D_TEMPLATE.indexOf('Verified commitments:')).toBeGreaterThan(
      ARM_D_TEMPLATE.indexOf('Meeting notes:')
    )
    expect(promptTemplateRecords(1, 'd').map((item) => item.name)).toEqual(['ARM_D_TEMPLATE'])
    expect(promptPackSha256(1, 'd')).toHaveLength(64)
    expect(promptPackSha256(1, 'd')).not.toBe(frozen.pack)
    expect(promptPackSha256(1, 'd')).not.toBe(promptPackSha256(1, 'c'))
  })

  it('Arm E templates are hashed separately and do not edit frozen A-D strings', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(sha256Utf8(ARM_B_TEMPLATE)).toBe(frozen.ARM_B_TEMPLATE)
    expect(sha256Utf8(ARM_C_TEMPLATE)).toBe(
      'ff22d7df86c4d74935b751ab1cac0c6dff86747804a94f6c726e90f01f091c91'
    )
    expect(ARM_E_GROUP_TEMPLATE).toContain('Output JSON only')
    expect(ARM_E_GROUP_TEMPLATE).toContain('{{ITEMS}}')
    expect(ARM_E_RESTYLE_TEMPLATE).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the input.'
    )
    expect(ARM_E_RESTYLE_TEMPLATE).toContain('Do not change tentative language into definite language.')
    expect(ARM_E_RESTYLE_TEMPLATE).toContain('{{TOPIC_NAME}}')
    expect(promptTemplateRecords(1, 'e').map((item) => item.name)).toEqual([
      'ARM_E_GROUP_TEMPLATE',
      'ARM_E_RESTYLE_TEMPLATE'
    ])
    expect(promptPackSha256(1, 'e')).toHaveLength(64)
    expect(promptPackSha256(1, 'e')).not.toBe(promptPackSha256(1, 'd'))
    expect(promptPackSha256(1, 'e')).not.toBe(frozen.pack)
  })

  it('Arm F compress template is hashed separately and does not edit frozen A-E strings', () => {
    expect(sha256Utf8(ARM_A_DIRECT_TEMPLATE)).toBe(frozen.ARM_A_DIRECT_TEMPLATE)
    expect(sha256Utf8(ARM_B_TEMPLATE)).toBe(frozen.ARM_B_TEMPLATE)
    expect(sha256Utf8(ARM_C_TEMPLATE)).toBe(
      'ff22d7df86c4d74935b751ab1cac0c6dff86747804a94f6c726e90f01f091c91'
    )
    expect(ARM_F_COMPRESS_TEMPLATE).toContain('Rewrite bullets maximally concise')
    expect(ARM_F_COMPRESS_TEMPLATE).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the input.'
    )
    expect(ARM_F_COMPRESS_TEMPLATE).toContain('Do not change tentative language into definite language.')
    expect(ARM_F_COMPRESS_TEMPLATE).toContain('{{TOPIC_NAME}}')
    expect(ARM_F_COMPRESS_TEMPLATE).toContain('{{SECTION}}')
    expect(sha256Utf8(ARM_F_COMPRESS_TEMPLATE)).toBe(
      'e17947a3633da3311ca804233485eef217f5d793dfa70945c0b6d782255f285e'
    )
    expect(ARM_F_COMPRESS_TEMPLATE_V2).toContain('Merge bullets that record the same topic')
    expect(ARM_F_COMPRESS_TEMPLATE_V2).toContain('Cut restated reasons')
    expect(sha256Utf8(ARM_F_COMPRESS_TEMPLATE_V2)).not.toBe(sha256Utf8(ARM_F_COMPRESS_TEMPLATE))
    expect(promptTemplateRecords(1, 'f').map((item) => item.name)).toEqual([
      'ARM_F_COMPRESS_TEMPLATE_V2'
    ])
    expect(promptPackSha256(1, 'f')).toHaveLength(64)
    expect(promptPackSha256(1, 'f')).not.toBe(promptPackSha256(1, 'e'))
    expect(promptPackSha256(1, 'f')).not.toBe(frozen.pack)
    expect(sha256Utf8(ARM_E_GROUP_TEMPLATE)).toBe(
      promptTemplateRecords(1, 'e').find((item) => item.name === 'ARM_E_GROUP_TEMPLATE')?.sha256
    )
  })

  it('fills placeholders and rejects missing keys', () => {
    const filled = fillTemplate(ARM_A_DIRECT_TEMPLATE, {
      MEETING_TITLE: 'Standup',
      TRANSCRIPT: 'Me: hello'
    })
    expect(filled).toContain('Meeting title: Standup')
    expect(filled).toContain('Me: hello')
    expect(filled.includes('{{')).toBe(false)
    expect(() => fillTemplate(ARM_A_DIRECT_TEMPLATE, { MEETING_TITLE: 'x' })).toThrow(
      'missing placeholder'
    )
  })
})
