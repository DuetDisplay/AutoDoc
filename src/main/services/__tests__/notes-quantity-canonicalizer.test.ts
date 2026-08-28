import { describe, expect, it } from 'vitest'
import {
  areQuantitiesGrounded,
  checkQuantityGrounding,
  extractQuantityMentions,
  quantityMentionsEquivalent
} from '../notes-quantity-canonicalizer'

describe('extractQuantityMentions', () => {
  it('returns typed mentions in source order and retains duplicates', () => {
    const mentions = extractQuantityMentions(
      'Trials rose twelve percent on v4.5.0 under a 50/50 split, then rose 12% again.'
    )

    expect(mentions.map((mention) => mention.kind)).toEqual([
      'percentage',
      'version',
      'ratio',
      'percentage'
    ])
    expect(mentions.map((mention) => mention.canonical)).toEqual([
      'percentage:12',
      'version:4.5.0',
      'ratio:50/50',
      'percentage:12'
    ])
    expect(mentions.map((mention) => mention.raw)).toEqual([
      'twelve percent',
      'v4.5.0',
      '50/50',
      '12%'
    ])
    expect(mentions[0]!.start).toBeLessThan(mentions[1]!.start)
    expect(mentions[2]!.aliases).toContain('fifty-fifty')
  })

  it('normalizes cardinal words and sequential spoken digits', () => {
    const [digits] = extractQuantityMentions('443')
    const [cardinal] = extractQuantityMentions('four hundred forty-three')
    const [sequence] = extractQuantityMentions('four four three')

    expect(digits?.canonical).toBe('number:443')
    expect(cardinal?.canonical).toBe('number:443')
    expect(sequence).toMatchObject({
      canonical: 'number:443',
      notation: 'digit-sequence'
    })
    expect(digits?.aliases).toEqual(
      expect.arrayContaining(['443', 'four hundred forty-three', 'four four three'])
    )
    expect(quantityMentionsEquivalent(digits!, cardinal!)).toBe(true)
    expect(quantityMentionsEquivalent(digits!, sequence!)).toBe(true)
  })

  it('normalizes decimal percentages expressed in digits or words', () => {
    expect(
      areQuantitiesGrounded('Conversion improved 12.5%.', 'It rose twelve point five percent.')
    ).toBe(true)
    expect(extractQuantityMentions('twelve per cent')[0]?.canonical).toBe('percentage:12')
  })

  it('preserves signs and distinguishes percentage points from percentages', () => {
    expect(
      areQuantitiesGrounded('Conversion fell -5%.', 'Conversion fell negative five percent.')
    ).toBe(true)
    expect(areQuantitiesGrounded('Conversion fell -5%.', 'Conversion fell -5%.')).toBe(true)
    expect(areQuantitiesGrounded('Conversion rose 5%.', 'Conversion fell -5%.')).toBe(false)
    expect(areQuantitiesGrounded('Lift was 12%.', 'Lift was twelve percentage points.')).toBe(false)
    expect(
      areQuantitiesGrounded('Lift was 12 percentage points.', 'Lift was twelve percentage points.')
    ).toBe(true)
  })

  it('recognizes common units without leaking a nested plain number', () => {
    const mentions = extractQuantityMentions(
      'Fallback took five minutes, used 16 GB, ran at 60 fps, and affected twelve users.'
    )
    expect(mentions.map((mention) => mention.canonical)).toEqual([
      'unit:minute:5',
      'unit:gigabyte:16',
      'unit:frame-per-second:60',
      'unit:user:12'
    ])
  })

  it('normalizes full-word magnitudes outside currency expressions', () => {
    expect(extractQuantityMentions('5 million users')[0]?.canonical).toBe('unit:user:5000000')
    expect(areQuantitiesGrounded('5 million users', 'five million users')).toBe(true)
  })

  it('does not extract digits embedded in an unknown alphanumeric identifier', () => {
    expect(extractQuantityMentions('Track this as DD1450 and foo123bar.')).toEqual([])
  })
})

describe('typed quantitative grounding', () => {
  it('matches percentage aliases without requiring every alias to appear', () => {
    const result = checkQuantityGrounding(
      'Trial starts improved 12%.',
      'They improved twelve percent.'
    )

    expect(result.supported).toBe(true)
    expect(result.summaryMentions[0]!.aliases.length).toBeGreaterThan(1)
    expect(result.matches[0]!.evidence?.raw).toBe('twelve percent')
  })

  it('rejects 12% when the evidence merely says twelve users', () => {
    const result = checkQuantityGrounding('Trial starts improved 12%.', 'We invited twelve users.')

    expect(result.supported).toBe(false)
    expect(result.unsupported.map((mention) => mention.canonical)).toEqual(['percentage:12'])
    expect(result.evidenceMentions.map((mention) => mention.canonical)).toEqual(['unit:user:12'])
  })

  it('requires explicit dot or point evidence for dotted versions', () => {
    expect(areQuantitiesGrounded('Ship v4.5.0 after QA.', 'Ship four five zero after QA.')).toBe(
      false
    )
    expect(
      areQuantitiesGrounded('Ship version 4.5.0.', 'The four point five point zero build is ready.')
    ).toBe(true)
    expect(extractQuantityMentions('Use the 3.5 version.')[0]?.canonical).toBe('version:3.5')
    expect(extractQuantityMentions('After 3.5 is released.')[0]?.canonical).toBe('version:3.5')
    expect(areQuantitiesGrounded('After 3.5 is released.', 'Once we release version 3.5.')).toBe(
      true
    )
  })

  it('keeps undotted build labels undotted when version/build context is explicit', () => {
    expect(
      areQuantitiesGrounded('Version 443 is ahead.', 'Four four three version is ahead.')
    ).toBe(true)
    expect(areQuantitiesGrounded('Ship v443.', 'Ship the four four three build.')).toBe(true)
    expect(areQuantitiesGrounded('Ship v4.4.3.', 'Ship the four four three build.')).toBe(false)
    expect(
      areQuantitiesGrounded('Ship v4.5.0.', 'Ship the four point five point zero build.')
    ).toBe(true)
    expect(areQuantitiesGrounded('Ship v443.', 'Ship the 443 build.')).toBe(true)
    expect(areQuantitiesGrounded('Version 435 is behind.', 'The 435 version is behind.')).toBe(true)
    expect(areQuantitiesGrounded('Ship v443.', 'There were 443 users.')).toBe(false)
  })

  it('rejects version/percentage mismatches and non-sequential cardinal amounts', () => {
    expect(areQuantitiesGrounded('Ship v4.5.0.', 'Conversion was 4.5%.')).toBe(false)
    expect(areQuantitiesGrounded('Ship v4.5.0.', 'There were four hundred fifty users.')).toBe(
      false
    )
    expect(areQuantitiesGrounded('Conversion was 12%.', 'Use version 12.')).toBe(false)
    expect(areQuantitiesGrounded('Ship v1.23.', 'Ship v12.3.')).toBe(false)
  })

  it('normalizes slash and conversational ratios', () => {
    expect(areQuantitiesGrounded('Use a 50/50 rollout.', 'Keep the fifty-fifty split.')).toBe(true)
    expect(areQuantitiesGrounded('Use a 50/50 rollout.', 'Keep the fifty fifty split.')).toBe(true)
    expect(areQuantitiesGrounded('Use a 50/50 rollout.', 'Keep the 50:50 split.')).toBe(true)
    expect(areQuantitiesGrounded('Use a 50/50 rollout.', 'Keep the 50-50 split.')).toBe(true)
    expect(areQuantitiesGrounded('Use a 50/50 rollout.', 'Use a 50/40 split.')).toBe(false)
  })

  it('normalizes currency symbols, words, and magnitudes while preserving currency type', () => {
    expect(areQuantitiesGrounded('Budget is $25.', 'We approved twenty-five dollars.')).toBe(true)
    expect(areQuantitiesGrounded('Budget is €1.5 million.', 'We approved 1,500,000 euros.')).toBe(
      true
    )
    expect(areQuantitiesGrounded('Budget is $25.', 'We approved twenty-five euros.')).toBe(false)
  })

  it('normalizes unit aliases but rejects incompatible units', () => {
    expect(areQuantitiesGrounded('Fallback takes 5 min.', 'Fallback takes five minutes.')).toBe(
      true
    )
    expect(areQuantitiesGrounded('Memory use is 16 GB.', 'Memory use is sixteen gigabytes.')).toBe(
      true
    )
    expect(areQuantitiesGrounded('Fallback takes 5 min.', 'Fallback takes five seconds.')).toBe(
      false
    )
  })

  it('normalizes an attached k magnitude when it modifies a count unit', () => {
    expect(areQuantitiesGrounded('We reached 5k users.', 'We reached 5,000 users.')).toBe(true)
  })

  it('normalizes numeric, percentage, and unit ranges', () => {
    expect(
      areQuantitiesGrounded('Allow 5-10 retries.', 'Allow between five and ten retries.')
    ).toBe(true)
    expect(
      areQuantitiesGrounded('Lift was 10–12%.', 'Lift was ten percent to twelve percent.')
    ).toBe(true)
    expect(areQuantitiesGrounded('Wait 5-10 minutes.', 'Wait five to ten min.')).toBe(true)
    expect(areQuantitiesGrounded('Wait 5-10 minutes.', 'Wait five to ten seconds.')).toBe(false)
    expect(areQuantitiesGrounded('Lift was 10-12%.', 'There were ten to twelve users.')).toBe(false)
  })

  it('reports each unsupported summary mention in original order', () => {
    const result = checkQuantityGrounding(
      'Conversion rose 12%, latency fell to 5 ms, and rollout stayed 50/50.',
      'Conversion rose twelve percent and latency fell to six milliseconds.'
    )

    expect(result.supported).toBe(false)
    expect(result.unsupported.map((mention) => mention.canonical)).toEqual([
      'unit:millisecond:5',
      'ratio:50/50'
    ])
    expect(result.matches.map((match) => match.evidenceIndex)).toEqual([0, null, null])
  })

  it('optionally enforces evidence multiplicity while retaining duplicate summary mentions', () => {
    const summary = 'The 12% result was confirmed; keep the 12% result.'
    const evidence = 'The result was twelve percent.'

    expect(checkQuantityGrounding(summary, evidence).supported).toBe(true)
    const consumed = checkQuantityGrounding(summary, evidence, { consumeEvidenceMentions: true })
    expect(consumed.supported).toBe(false)
    expect(consumed.unsupported.map((mention) => mention.raw)).toEqual(['12%'])
  })
})
