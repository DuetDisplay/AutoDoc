import { describe, expect, it } from 'vitest'

import { planArmA, armAPromptTokensWithoutTranscript } from '../arm-a.ts'
import { planArmB } from '../arm-b.ts'
import { planArmC, armCPromptTokensWithoutTranscript } from '../arm-c.ts'
import { planArmD } from '../arm-d.ts'
import { planArmFCompress } from '../arm-f.ts'
import { parseRunArgs } from '../cli.ts'
import { projectTurns } from '../transcript-projection.ts'

describe('arm planners', () => {
  it('builds a single-call Arm A prompt from a short synthetic projection', () => {
    const projection = projectTurns(
      'Standup',
      [
        { speakerLabel: 'Me', text: 'alpha' },
        { speakerLabel: 'Them', text: 'beta' }
      ],
      armAPromptTokensWithoutTranscript(),
      4096
    )
    const plan = planArmA(projection, 0)
    expect(plan.mode).toBe('single-call')
    expect(plan.calls).toHaveLength(1)
    expect(plan.calls[0]?.request.options.temperature).toBe(0)
    expect(plan.calls[0]?.request.options.num_ctx).toBe(32768)
    expect(plan.calls[0]?.prompt).toContain('Meeting title: Standup')
    expect(plan.calls[0]?.prompt).toContain('Me: alpha')
    expect(plan.calls[0]?.prompt.includes('[')).toBe(false)
    expect(plan.promptVersion).toBe(1)
    expect(plan.calls[0]?.templateName).toBe('ARM_A_DIRECT_TEMPLATE')
  })

  it('uses v2 Arm A templates when promptVersion is 2', () => {
    const projection = projectTurns(
      'Standup',
      [{ speakerLabel: 'Me', text: 'alpha' }],
      armAPromptTokensWithoutTranscript(2),
      4096
    )
    const plan = planArmA(projection, 0.4, 2)
    expect(plan.promptVersion).toBe(2)
    expect(plan.calls[0]?.templateName).toBe('ARM_A_DIRECT_TEMPLATE_V2')
    expect(plan.calls[0]?.prompt).toContain('Brevity must never drop a commitment.')
    expect(plan.calls[0]?.request.options.temperature).toBe(0.4)
  })

  it('uses v3 Arm A templates when promptVersion is 3', () => {
    const projection = projectTurns(
      'Standup',
      [{ speakerLabel: 'Me', text: 'alpha' }],
      armAPromptTokensWithoutTranscript(3),
      4096
    )
    const plan = planArmA(projection, 0.4, 3, 43)
    expect(plan.promptVersion).toBe(3)
    expect(plan.calls[0]?.templateName).toBe('ARM_A_DIRECT_TEMPLATE_V3')
    expect(plan.calls[0]?.prompt).toContain('Required output shape')
    expect(plan.calls[0]?.request.options.seed).toBe(43)
  })

  it('builds Arm B around the verbatim compress instruction', () => {
    const plan = planArmB('## Topic\n- A point\n- The same point restated\n', 0.4)
    expect(plan.request.options.temperature).toBe(0.4)
    expect(plan.request.options.num_ctx).toBe(16384)
    expect(plan.prompt).toContain('roughly half the length')
    expect(plan.prompt).toContain('## Topic')
    expect(plan.filledPromptSha256).toHaveLength(64)
  })

  it('builds Arm C around the extractor template and seed', () => {
    const projection = projectTurns(
      'Standup',
      [{ speakerLabel: 'Me', text: 'I will send the doc' }],
      armCPromptTokensWithoutTranscript(),
      2048
    )
    const plan = planArmC(projection, 0.4, 42)
    expect(plan.mode).toBe('single-call')
    expect(plan.templateName).toBe('ARM_C_TEMPLATE')
    expect(plan.prompt).toContain('Meeting title: Standup')
    expect(plan.prompt).toContain('I will send the doc')
    expect(plan.prompt).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the transcript.'
    )
    expect(plan.prompt).toContain('Never promote tentative, maybe, or should-consider language into commitments.')
    expect(plan.request.options.temperature).toBe(0.4)
    expect(plan.request.options.seed).toBe(42)
    expect(plan.request.options.num_ctx).toBe(32768)
    expect(plan.templateSha256).toHaveLength(64)
    expect(plan.filledPromptSha256).toHaveLength(64)
  })

  it('builds Arm D around the restyle template, notes, and commitments', () => {
    const plan = planArmD(
      '## Topic\n- Keep the Orion soak numbers\n',
      '* **Send the soak report** (Alex) — So QA can start Friday.\n',
      0.4,
      42
    )
    expect(plan.mode).toBe('single-call')
    expect(plan.templateName).toBe('ARM_D_TEMPLATE')
    expect(plan.prompt).toContain('Keep the Orion soak numbers')
    expect(plan.prompt).toContain('Send the soak report')
    expect(plan.prompt).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the input.'
    )
    expect(plan.prompt).toContain('Required output shape')
    expect(plan.request.options.temperature).toBe(0.4)
    expect(plan.request.options.seed).toBe(42)
    expect(plan.request.options.num_ctx).toBe(16384)
    expect(plan.request.options.num_predict).toBe(4096)
    expect(plan.templateSha256).toHaveLength(64)
    expect(plan.filledPromptSha256).toHaveLength(64)
  })

  it('builds Arm F around the compress template and seed', () => {
    const plan = planArmFCompress('Orion soak', '* HP opt-in is 80-95%.\n', 0.4, 42)
    expect(plan.templateName).toBe('ARM_F_COMPRESS_TEMPLATE_V2')
    expect(plan.prompt).toContain('Orion soak')
    expect(plan.prompt).toContain('HP opt-in is 80-95%')
    expect(plan.prompt).toContain(
      'Do not add any fact, name, number, owner, date, or causal claim that is not in the input.'
    )
    expect(plan.request.options.temperature).toBe(0.4)
    expect(plan.request.options.seed).toBe(42)
    expect(plan.request.options.num_ctx).toBe(8192)
    expect(plan.request.options.num_predict).toBe(1024)
    expect(plan.templateSha256).toHaveLength(64)
    expect(plan.filledPromptSha256).toHaveLength(64)
  })
})

describe('run CLI', () => {
  it('accepts preregistered temperatures and rejects others', () => {
    expect(parseRunArgs(['--arm', 'a', '--temperature', '0', '--inspect']).inspect).toBe(true)
    expect(parseRunArgs(['--arm', 'a', '--temperature', '0', '--inspect']).promptVersion).toBe(1)
    expect(
      parseRunArgs(['--arm', 'a', '--temperature', '0.4', '--prompt-version', '2']).promptVersion
    ).toBe(2)
    expect(parseRunArgs(['--arm', 'b', '--temperature', '0.4', '--input', 'x.md']).arm).toBe('b')
    expect(() => parseRunArgs(['--arm', 'a', '--temperature', '0.7'])).toThrow('0 or 0.4')
    expect(
      parseRunArgs(['--arm', 'a', '--temperature', '0.4', '--prompt-version', '3']).promptVersion
    ).toBe(3)
    expect(parseRunArgs(['--arm', 'a', '--inspect']).seed).toBe(42)
    expect(parseRunArgs(['--arm', 'a', '--seed', '43']).seed).toBe(43)
    expect(() => parseRunArgs(['--arm', 'a', '--prompt-version', '4'])).toThrow('1, 2, or 3')
    expect(parseRunArgs(['--arm', 'c', '--inspect']).arm).toBe('c')
    expect(parseRunArgs(['--arm', 'd', '--inspect']).arm).toBe('d')
    expect(parseRunArgs(['--arm', 'e', '--inspect']).arm).toBe('e')
    expect(
      parseRunArgs([
        '--arm',
        'd',
        '--temperature',
        '0.4',
        '--input',
        'legacy.md',
        '--commitments',
        'verified.md'
      ]).commitments
    ).toBe('verified.md')
    expect(
      parseRunArgs([
        '--arm',
        'e',
        '--temperature',
        '0.4',
        '--input',
        'segments.json',
        '--extractor',
        'extract.md',
        '--fixture',
        'fixture'
      ]).extractor
    ).toBe('extract.md')
    expect(parseRunArgs(['--arm', 'f', '--inspect']).arm).toBe('f')
    expect(parseRunArgs(['--arm', 'g', '--inspect']).arm).toBe('g')
    expect(
      parseRunArgs([
        '--arm',
        'g',
        '--input',
        'candidate.md',
        '--coverage-key',
        'key.md'
      ]).coverageKey
    ).toBe('key.md')
    expect(() => parseRunArgs(['--arm', 'h'])).toThrow('a, b, c, d, e, f, or g')
  })
})
