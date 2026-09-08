import { describe, expect, it } from 'vitest'
import {
  evidenceToWriterJson,
  isWindowsEvidenceWriterEnabled,
  WINDOWS_EVIDENCE_WRITER_FORMAT
} from '../windows-notes-evidence'

const transcript = '[L1] [me] Alex: Can we add conversion tracking?\n[L2] [them] Renée: That event already exists.\n[L3] [them] Renée: I will investigate the report if we can reproduce it.'
const selection = { t: 'Conversion tracking', s: 1, e: 3, k: 'a' }
const decode = (notes: unknown[], text = transcript): unknown => JSON.parse(evidenceToWriterJson(JSON.stringify({ notes }), text))

describe('Windows evidence selection', () => {
  it('requires Windows and the explicit evidence flag', () => {
    expect(isWindowsEvidenceWriterEnabled('win32', 'evidence')).toBe(true)
    for (const platform of ['darwin', 'linux'] as const) expect(isWindowsEvidenceWriterEnabled(platform, 'evidence')).toBe(false)
    for (const flag of ['', 'flat', 'state', '1']) expect(isWindowsEvidenceWriterEnabled('win32', flag)).toBe(false)
  })

  it('copies the entire selected exchange including negation and conditions without paraphrasing', () => {
    expect(decode([selection])).toEqual({ a: [['Conversion tracking',
      'Alex: Can we add conversion tracking? Renée: That event already exists. Renée: I will investigate the report if we can reproduce it.', 1, 3]] })
  })

  it('only strips source and speaker markers and normalizes spaces', () => {
    const text = '[L1]  [me]   Revenue  was $1,250.50;\t30% is not 20%.\r\n[L2] [them] It is NOT causal [L99], and [me] stays inside prose.'
    expect(decode([{ t: 'Metrics', s: 1, e: 2, k: 'i' }], text)).toEqual({ i: [['Metrics',
      'Revenue was $1,250.50; 30% is not 20%. It is NOT causal [L99], and [me] stays inside prose.', 1, 2]] })
  })

  it('keeps one canonical role and heading for duplicate exact ranges', () => {
    expect(decode([selection, { ...selection, t: 'Different heading', k: 'd' }])).toEqual(decode([selection]))
  })

  it('bounds ranges by the supplied source, not arbitrary ASR line counts', () => {
    expect(decode([])).toEqual({})
    const text = Array.from({ length: 7 }, (_, i) => `[L${i + 1}] Source ${i + 1}.`).join('\n')
    expect(decode([{ ...selection, s: 1, e: 6 }], text)).toEqual({ a: [['Conversion tracking',
      'Source 1. Source 2. Source 3. Source 4. Source 5. Source 6.', 1, 6]] })
    expect(decode([{ ...selection, s: 1, e: 7 }], text)).toEqual({ a: [['Conversion tracking',
      'Source 1. Source 2. Source 3. Source 4. Source 5. Source 6. Source 7.', 1, 7]] })
    expect(() => decode([{ ...selection, s: 1, e: 999999 }], text)).toThrow('invalid range')
    expect(() => decode(Array.from({ length: 7 }, () => selection))).toThrow('more than 6 selections')
    expect(WINDOWS_EVIDENCE_WRITER_FORMAT.properties.notes.maxItems).toBe(6)
  })

  it('rejects malformed shapes, categories and numeric citations without repairing them', () => {
    for (const raw of ['```json\n{"notes":[]}\n```', '{"notes":', '[]', '{}',
      '{"notes":[],"overview":{}}']) expect(() => evidenceToWriterJson(raw, transcript)).toThrow('Invalid evidence selection:')
    for (const invalid of [null, [], { ...selection, c: 'Invented text.' }, { ...selection, k: 'x' },
      { ...selection, t: '  ' }, { ...selection, s: 'L1' }, { ...selection, s: 0 },
      { ...selection, s: 1.5 }, { ...selection, e: 2.5 }, { ...selection, e: Number.MAX_SAFE_INTEGER + 1 },
      { ...selection, s: 3, e: 2 }]) expect(() => decode([invalid])).toThrow('Invalid evidence selection:')
  })

  it('requires every selected line and rejects ambiguous duplicate source IDs', () => {
    expect(() => decode([selection], '[L1] First.\n[L3] Last.')).toThrow('missing source line')
    expect(() => decode([selection], transcript + '\n[L2] Different source.')).toThrow('duplicate source line ID')
    expect(() => decode([{ ...selection, s: 1, e: 1 }], '[L1] [me]  ')).toThrow('no source text')
  })
})
