import { describe, expect, it } from 'vitest'

import {
  joinNotesDocument,
  judgeCompression,
  passthroughRaw,
  planArmFCompress,
  reconstructWith,
  sectionBody,
  splitNotesDocument,
  stripEmittedHeading,
  withSectionBody
} from '../arm-f.ts'
import { ARM_F_RETRY_SEED } from '../constants.ts'
import { extraFacts, factsPass } from '../facts.ts'
import { parseCoverageKey, scoreCoverage, scoreItem } from '../coverage.ts'
import { ARM_F_COMPRESS_TEMPLATE } from '../prompts.ts'

const sample = `# Standup

## Orion soak
* HP opt-in is 80-95% because Alex tracked Orion.
* The same HP opt-in range was restated.

## Decisions
* **Ship Thursday** — We agreed to ship the Orion soak on Thursday. (Alex)

## Next Steps
* **Send the soak report** (Alex) — So QA can start Friday.
`

const key = `| ID | Type | Granola claim (compressed) | Grounded | Transcript support | Notes |
|---|---|---|---|---|---|
| K1 | metric | HP opt-in 80-95% | yes | ~00:01 | |
| K2 | metric | Invented 12 widgets | **no** | not in transcript | Exclude. |
| K3 | commitment | Send the soak report (Alex) | yes | ~00:02 | |
`

describe('Arm F document split', () => {
  it('roundtrips markdown and isolates Decisions/Next Steps', () => {
    const chunks = splitNotesDocument(sample)
    expect(joinNotesDocument(chunks)).toBe(sample)
    expect(chunks.map((chunk) => chunk.kind)).toEqual([
      'prefix',
      'topical',
      'decisions',
      'nextSteps'
    ])
    const replaced = reconstructWith(chunks, 1, '* HP opt-in is 80-95%.\n')
    expect(passthroughRaw(replaced, 'decisions')).toBe(passthroughRaw(chunks, 'decisions'))
    expect(passthroughRaw(replaced, 'nextSteps')).toBe(passthroughRaw(chunks, 'nextSteps'))
    expect(joinNotesDocument(replaced)).not.toBe(sample)
    expect(sectionBody(chunks[1]!.raw)).toContain('HP opt-in')
  })

  it('preserves a trailing newline when replacing a section body', () => {
    const raw = '## Topic\n* One fact.\n'
    expect(withSectionBody(raw, '* Shorter.')).toBe('## Topic\n* Shorter.\n')
  })
})

describe('Arm F compression guards', () => {
  it('accepts a lossless shorter rewrite and rejects dropped facts', () => {
    const items = parseCoverageKey(key)
    const input = '* HP opt-in is 80-95% because Alex tracked Orion.'
    const kept = '* HP opt-in is 80-95% (Alex, Orion).'
    const dropped = '* Opt-in is high.'
    const trialKept = sample.replace(sectionBody(splitNotesDocument(sample)[1]!.raw), kept)
    expect(
      judgeCompression({
        inputSection: input,
        compressed: kept,
        trialDocument: trialKept,
        baselineStrict: scoreCoverage(sample, items).strict,
        coverageItems: items
      }).accept
    ).toBe(true)
    expect(
      judgeCompression({
        inputSection: input,
        compressed: dropped,
        trialDocument: sample.replace(input, dropped),
        baselineStrict: scoreCoverage(sample, items).strict,
        coverageItems: items
      })
    ).toMatchObject({ accept: false, reason: 'facts' })
    expect(factsPass(input, dropped)).toBe(false)
  })

  it('rejects a rewrite that leaks a catalog item id', () => {
    const items = parseCoverageKey(key)
    const input = '* Orion soak fires before consent.'
    const leaked = '* i03 indicates Orion soak fires before consent.'
    expect(
      judgeCompression({
        inputSection: input,
        compressed: leaked,
        trialDocument: leaked,
        baselineStrict: 0,
        coverageItems: items
      })
    ).toMatchObject({ accept: false, reason: 'item-id' })
  })

  it('rejects a rewrite that invents a number', () => {
    const items = parseCoverageKey(key)
    const input = '* HP opt-in is 80-95% because Alex tracked Orion.'
    const invented = '* HP opt-in is 80-95% across 12 Orion nodes Alex tracked.'
    expect(extraFacts(input, invented).numbers).toContain('12')
    expect(
      judgeCompression({
        inputSection: input,
        compressed: invented,
        trialDocument: invented,
        baselineStrict: 0,
        coverageItems: items
      })
    ).toMatchObject({ accept: false, reason: 'ungrounded' })
  })

  it('rejects a rewrite that drops coverage below the uncompressed baseline', () => {
    const items = parseCoverageKey(key)
    const input = sectionBody(splitNotesDocument(sample)[1]!.raw)
    const keptShape = '* Alex tracked Orion without the opt-in range.'
    expect(factsPass(input, keptShape)).toBe(false)
    const almost = '* HP 80-95% (Alex, Orion).'
    const baseline = scoreCoverage(sample, items).strict
    const trial = sample.replace(input, '* Unrelated filler about weather.')
    const judgment = judgeCompression({
      inputSection: almost,
      compressed: almost,
      trialDocument: trial,
      baselineStrict: baseline,
      coverageItems: items
    })
    expect(judgment.accept).toBe(false)
    expect(judgment.reason).toBe('coverage')
  })

  it('strips an emitted heading and plans a hashed compress call', () => {
    const plan = planArmFCompress('Orion soak', '* HP opt-in is 80-95%.', 0.4, 42)
    expect(plan.templateName).toBe('ARM_F_COMPRESS_TEMPLATE_V2')
    expect(plan.temperature).toBe(0.4)
    expect(plan.request.options.seed).toBe(42)
    expect(plan.prompt).toContain('Do not add any fact, name, number, owner, date, or causal claim that is not in the input.')
    expect(plan.prompt).toContain('Rewrite bullets maximally concise')
    expect(plan.prompt).toContain('Merge bullets that record the same topic')
    expect(plan.prompt).toContain('Cut restated reasons')
    expect(plan.prompt).toContain('* HP opt-in is 80-95%.')
    expect(ARM_F_RETRY_SEED).toBe(1337)
    expect(ARM_F_COMPRESS_TEMPLATE).toContain('{{SECTION}}')
    expect(stripEmittedHeading('## Orion soak\n* HP opt-in is 80-95%.\n', 'Orion soak')).toBe(
      '* HP opt-in is 80-95%.'
    )
  })
})

describe('coverage key scoring', () => {
  it('parses grounded rows and scores present/partial/absent', () => {
    const items = parseCoverageKey(key)
    expect(items).toHaveLength(3)
    expect(items.filter((item) => item.grounded).map((item) => item.id)).toEqual(['K1', 'K3'])
    expect(scoreItem('HP opt-in 80-95%', sample)).toBe('present')
    expect(scoreItem('HP opt-in 80-95%', 'No metrics here.')).toBe('absent')
    const scored = scoreCoverage(sample, items)
    expect(scored.n).toBe(2)
    expect(scored.present).toBeGreaterThanOrEqual(1)
    expect(scored.strict).toBeGreaterThan(0)
  })
})
