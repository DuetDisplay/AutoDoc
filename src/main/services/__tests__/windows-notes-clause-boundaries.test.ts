import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeWriterRecords, type WriterGroundingMode } from '../notes-writer-grounding'

const platform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
})

function ground(content: string, evidence: string, mode: WriterGroundingMode = 'paraphrase') {
  return sanitizeWriterRecords(
    'information',
    { title: content, content },
    { startMs: 1000, endMs: 1000 },
    [{ startMs: 1000, text: evidence }],
    mode
  ).map((record) => record.content)
}

describe('Windows claim-boundary preservation', () => {
  it.each([
    'The team will compare time groups (e.g., 2, 5, 15, 20 minutes)',
    'Dr. Singh will review the draft',
    'J. Singh will review the draft',
    'The team will meet at 3 p.m. tomorrow',
    'The memory cap is 1.5 GB',
    'The team will use release v1.2.0 for the pilot'
  ])('salvages the complete claim without breaking internal punctuation: %s', (claim) => {
    expect(ground(`${claim}; the budget is 700 dollars.`, `${claim}. The budget is 500 dollars.`))
      .toEqual([claim])
  })

  it('still separates a true sentence after an abbreviation-bearing claim', () => {
    const first = 'Dr. Singh will review the draft'
    const second = 'The memory cap is 1.5 GB'
    expect(ground(
      `${first}. ${second}. The budget is 700 dollars.`,
      `${first}. ${second}. The budget is 500 dollars.`
    )).toEqual([first, second])
  })

  it.each([
    'The team will ship v2.1 after QA passes',
    'The team will ship v2.1 only if QA passes',
    'The team will retain v2.1 unless QA finds a critical defect',
    'The team will retain v2.1 (unless QA finds a critical defect; then reconsider)',
    'The team will inspect the ramp to confirm access for wheelchairs',
    'The team delayed shipment because the bridge closed',
    'The team delayed shipment — until QA passes',
    'The team will retain v2.1, while QA runs',
    'The team will retain v2.1, until QA passes',
    'The team will ship v2.1, provided that QA passes'
  ])('retains a claim together with its condition or purpose: %s', (claim) => {
    expect(ground(`${claim}; the budget is 700 dollars.`, `${claim}. The budget is 500 dollars.`))
      .toEqual([claim])
  })

  it('does not publish a dangling parenthetical fragment from an incomplete draft', () => {
    const result = ground(
      'The team will compare time groups (e.g., 2, 5, 15, 20 minutes; the budget is 700 dollars.',
      'The team will compare time groups (e.g., 2, 5, 15, 20 minutes). The budget is 500 dollars.'
    )
    expect(result.every((text) => !text.includes('(') || text.includes(')'))).toBe(true)
    expect(result).not.toContain('The team will compare time groups (e')
  })

  it.each([
    'Plan to ship v2.1 and notify customers, both only after QA passes',
    'Plan to ship v2.1 now and notify customers only after QA passes',
    'Plan to inspect the ramp and move the chairs to improve wheelchair access'
  ])('keeps a coordinated plan intact without guessing qualifier scope: %s', (claim) => {
    expect(ground(`${claim}; the budget is 700 dollars.`, `${claim}. The budget is 500 dollars.`))
      .toEqual([claim])
  })

  it('does not salvage an unconditional action from an invalid qualified plan', () => {
    const result = ground(
      'Plan to ship v2.1 and notify 50 customers, both only after QA passes.',
      'Plan to ship v2.1 and notify 10 customers, both only after QA passes.'
    )
    expect(result).not.toContain('Plan to ship v2.1')
    expect(result.every((claim) => !claim.includes('ship') || claim.includes('after QA passes'))).toBe(true)
    expect(result.every((claim) => !claim.includes('50'))).toBe(true)
  })

  it('does not promote an unsupported example-bearing proposal to a decision', () => {
    const content = 'Implement time groups (e.g., 2, 5, 15, 20 minutes) for the trial.'
    const result = sanitizeWriterRecords(
      'decisions',
      { title: content, content },
      { startMs: 1000, endMs: 1000 },
      [{ startMs: 1000, text: 'Could we use time groups, maybe 2, 5, 15, or 20 minutes? We have not decided.' }],
      'paraphrase'
    )
    expect(result.some((record) => record.category === 'decisions')).toBe(false)
    expect(result.some((record) => record.content.endsWith('(e'))).toBe(false)
  })

  it('leaves the existing macOS verbatim path unaffected by the Windows flag', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const content = 'The memory cap is 1.5 GB; the budget is 700 dollars.'
    const evidence = 'The memory cap is 1.5 GB. The budget is 500 dollars.'
    const withWindowsFlag = ground(content, evidence, 'verbatim')
    vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '')
    expect(ground(content, evidence, 'verbatim')).toEqual(withWindowsFlag)
    expect(withWindowsFlag).toEqual(['The memory cap is 1.5 GB'])
  })
})
