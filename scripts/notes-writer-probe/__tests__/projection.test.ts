import { describe, expect, it } from 'vitest'

import { ARM_A_NUM_PREDICT } from '../constants.ts'
import { estimateTokens } from '../tokens.ts'
import {
  chunkTurns,
  chooseWriterMode,
  formatTurn,
  parseDerivedMarkdown,
  projectTurns,
  speakerLabelFor,
  stripTimestampPrefix,
  type LabeledTurn
} from '../transcript-projection.ts'

function turn(speakerLabel: string, text: string): LabeledTurn {
  return { speakerLabel, text }
}

function paddedTurn(index: number, chars: number): LabeledTurn {
  return turn('Me', `turn-${index} ${'x'.repeat(chars)}`)
}

describe('timestamp stripping and labels', () => {
  it('strips [mm:ss] prefixes and leaves body text', () => {
    expect(stripTimestampPrefix('[12:34] hello')).toBe('hello')
    expect(stripTimestampPrefix('[1:02:03] hello')).toBe('hello')
    expect(stripTimestampPrefix('hello')).toBe('hello')
  })

  it('maps me/them labels without using fixture content', () => {
    expect(speakerLabelFor('me')).toBe('Me')
    expect(speakerLabelFor('them')).toBe('Them')
    expect(speakerLabelFor('me', { me: 'Me', them: 'Them' })).toBe('Me')
    expect(formatTurn(turn('Them', 'hi'))).toBe('Them: hi')
  })

  it('parses derived markdown lines and drops the timestamp span', () => {
    const markdown = [
      '# AutoDoc transcript',
      '- **00:00:00–00:00:09 · them:** Alpha synthetic body',
      '- **00:00:10–00:00:12 · me:** Beta synthetic body'
    ].join('\n')
    expect(parseDerivedMarkdown(markdown)).toEqual([
      { speakerLabel: 'Them', text: 'Alpha synthetic body' },
      { speakerLabel: 'Me', text: 'Beta synthetic body' }
    ])
  })
})

describe('chunking boundaries', () => {
  it('keeps a short transcript as one chunk and overlaps long ones on turn boundaries', () => {
    const short = [turn('Me', 'one'), turn('Them', 'two')]
    expect(chunkTurns(short, 4000, 400)).toHaveLength(1)

    const long: LabeledTurn[] = []
    for (let index = 0; index < 12; index += 1) {
      long.push(paddedTurn(index, 1600))
    }
    const chunks = chunkTurns(long, 4000, 400)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.turns[0]?.text.startsWith('turn-0 ')).toBe(true)
    const firstEnd = chunks[0]?.turns.at(-1)?.text ?? ''
    const secondStart = chunks[1]?.turns[0]?.text ?? ''
    expect(firstEnd).not.toBe('')
    expect(secondStart).not.toBe('')
    expect(chunks[0]?.turns.some((item) => item.text === secondStart)).toBe(true)
    for (const chunk of chunks) {
      expect(chunk.total).toBe(chunks.length)
      expect(chunk.estimatedTokens).toBe(estimateTokens(chunk.text))
    }
  })

  it('emits a solo chunk when one turn exceeds the target', () => {
    const huge = [paddedTurn(0, 20000), turn('Them', 'tail')]
    const chunks = chunkTurns(huge, 4000, 400)
    expect(chunks[0]?.turns).toHaveLength(1)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('single-call vs hierarchy decision', () => {
  it('selects single-call when 32K has leftover headroom and hierarchy when it does not', () => {
    expect(chooseWriterMode(8000, 4096, 32768, 1024)).toBe('single-call')
    expect(chooseWriterMode(28000, 4096, 32768, 1024)).toBe('chunk-hierarchy')
  })

  it('projects stats without timestamps in writer text', () => {
    const projection = projectTurns(
      'Standup',
      [turn('Me', '[00:01] should already be stripped'), turn('Them', 'ok')],
      200,
      ARM_A_NUM_PREDICT
    )
    expect(projection.text.includes('[00:01]')).toBe(false)
    expect(projection.text.startsWith('Meeting: Standup\n\n')).toBe(true)
    expect(projection.stats.turnCount).toBe(2)
    expect(projection.stats.chunkTargetTokens).toBe(4000)
    expect(projection.stats.contextBudgetTokens).toBe(32768)
  })
})
