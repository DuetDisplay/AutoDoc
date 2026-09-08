import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnoseWriterRecord, sanitizeWriterRecords } from '../notes-writer-grounding'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
})
function enable(os: NodeJS.Platform = 'win32', mode = 'lines'): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: os })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', mode)
}
const sampleSource = 'Iman: We have 24 river samples from Monday. Eighteen passed the initial checks and six are still waiting for a rerun. The six aren\'t confirmed failures. I\'ll rerun those on Thursday morning, with the revised blank checks.'
const sampleNote = 'Of 24 river samples, 18 passed initial checks and 6 are pending rerun with no confirmed failure.'
function sanitize(content: string, text = sampleSource, category: 'information' | 'action_items' = 'information') {
  return sanitizeWriterRecords(category, { title: content, content }, { startMs: 0, endMs: 0 }, [{ startMs: 0, text }], 'paraphrase')
}
function completion(content: string, text: string): boolean | undefined {
  return diagnoseWriterRecord('information', { title: content, content }, { startMs: 0, endMs: 0 }, [{ startMs: 0, text }])?.checks.completion
}

describe('Windows completion quantity binding', () => {
  it('preserves the complete cohort status across numeric and written number forms', () => {
    enable()
    expect(sanitize(sampleNote)).toEqual([expect.objectContaining({ content: sampleNote, salvaged: false })])
    expect(completion('18 passed initial checks.', 'Eighteen passed initial checks.')).toBe(true)
    expect(completion('Eighteen passed initial checks.', '18 passed initial checks.')).toBe(true)
    expect(completion('6 passed initial checks.', 'Six passed initial checks.')).toBe(true)
  })

  it.each([
    'Six samples await reruns and eighteen passed initial checks.',
    'Eighteen passed initial checks and six samples are pending rerun.',
    'There are 24 samples in total. Eighteen samples passed initial checks.',
    'Eighteen of 24 samples passed initial checks.'
  ])('does not borrow completion from another cohort: %s', source => {
    enable()
    for (const claim of ['Six samples passed initial checks.', '6 passed initial checks.',
      '24 samples passed initial checks.', 'All 24 samples passed initial checks.']) {
      expect(completion(claim, source), claim).toBe(false)
      expect(sanitize(claim, source).some(record => record.content === claim && !record.salvaged), claim).toBe(false)
    }
  })

  it('does not accept failure, confirmed-failure or unsupported-purpose assertions', () => {
    enable()
    for (const claim of ['6 river samples failed initial checks.', 'The six are confirmed failures.', 'All 24 river samples passed initial checks.']) {
      expect(sanitize(claim).some(record => record.content === claim), claim).toBe(false)
    }
    const claim = "Sofia will check access permissions this afternoon to resolve Paul's inability to find the existing manifest."
    const source = "Sofia: There is already a shared manifest in the field folder; I made it last month. I can see the boxes there. I'll check the access permissions this afternoon, because that may explain why Paul can't find it."
    expect(sanitize(claim, source, 'action_items').some(record => record.content === claim)).toBe(false)
  })

  it('retains platform and product identity requirements alongside number equivalence', () => {
    enable()
    expect(completion('Windows version 11 passed QA.', 'Mac version eleven passed QA.')).toBe(false)
    expect(completion('Atlas version 11 passed QA.', 'Beacon version eleven passed QA.')).toBe(false)
    expect(completion('Atlas version 11 passed QA.', 'Atlas version eleven passed QA.')).toBe(true)
  })

  it('applies number-word completion on default Windows grounding', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '0')
    expect(completion('18 passed initial checks.', 'Eighteen passed initial checks.')).toBe(true)
  })

  it('keeps non-Windows completion behavior unchanged', () => {
    for (const [os, mode] of [['darwin', 'lines'], ['linux', 'lines']] as const) {
      enable(os, mode)
      expect(completion('18 passed initial checks.', 'Eighteen passed initial checks.')).toBe(false)
    }
  })
})
