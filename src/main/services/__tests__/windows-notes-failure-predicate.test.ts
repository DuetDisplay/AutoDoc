import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeWriterRecords } from '../notes-writer-grounding'

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'lines')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.unstubAllEnvs()
})

function retains(claim: string, text: string): boolean {
  return sanitizeWriterRecords(
    'information', { title: claim, content: claim }, { startMs: 1000, endMs: 1000 },
    [{ startMs: 1000, text }], 'paraphrase'
  ).some((record) => record.content === claim)
}

describe('Windows affirmative failure binding', () => {
  it.each([
    ['6 river samples failed initial checks.', "Eighteen river samples passed initial checks. Six are awaiting reruns; the six aren't confirmed failures."],
    ['18 river samples failed initial checks.', 'Eighteen river samples passed initial checks. Six river samples failed initial checks.'],
    ['18 river samples failed initial checks.', 'Six river samples failed initial checks and eighteen river samples passed initial checks.'],
    ['The six are confirmed failures.', "The six aren't confirmed failures."],
    ['6 samples failed checks.', 'Six samples might have failed checks.'],
    ['6 samples failed checks.', 'Six samples will fail checks.'],
    ['Atlas build failed QA.', 'Atlas build passed QA. Beacon build failed QA.'],
    ['Build A failed QA.', 'Build A passed QA. Build B failed QA.'],
    ['Atlas build passed QA.', 'Atlas build is not a confirmed failure.'],
    ['Atlas build failed QA.', 'Atlas build is not a confirmed failure.'],
    ['Atlas fails to compile.', 'Atlas compiles.'],
    ['Atlas fails to compile.', 'Atlas might not compile.'],
    ['Atlas fails to compile.', 'Atlas will fail to compile.'],
    ['Atlas fails to compile.', 'Atlas does not fail to compile.'],
    ['Atlas fails to compile.', 'Atlas compiles. Beacon does not compile.'],
    ['Build A fails to compile.', 'Build A compiles. Build B does not compile.'],
    ['6 samples failed to pass checks.', 'Six samples passed checks. Eighteen samples did not pass checks.'],
    ['6 samples failed to pass checks.', "Eighteen samples passed checks. Six await reruns and aren't confirmed failures."]
  ])('rejects an unsupported outcome: %s', (claim, text) => {
    expect(retains(claim, text)).toBe(false)
  })

  it.each([
    ['6 river samples failed initial checks.', 'Six river samples failed initial checks. Eighteen river samples passed initial checks.'],
    ['6 samples failed checks.', 'Six samples failed checks.'],
    ['The six are confirmed failures.', 'The six are confirmed failures.'],
    ['Atlas build failed QA.', 'Atlas build failed QA. Beacon build passed QA.'],
    ['Build A failed QA.', 'Build A failed QA. Build B passed QA.'],
    ['A deployment failed.', 'The deployment failed.'],
    ['Atlas failed to compile.', 'Atlas failed to compile.'],
    ['Atlas fails to compile.', 'Atlas does not compile.'],
    ['Atlas failed to compile.', "Atlas didn't compile."],
    ['6 samples failed to pass checks.', 'Six samples did not pass checks.'],
    ['The app icon fails to update in real-time when system dark mode changes, requiring app restart to reflect new mode.', 'The app icon does not reflect this change immediately, so you have to restart the app.']
  ])('keeps an explicitly supported failure: %s', (claim, text) => {
    expect(retains(claim, text)).toBe(true)
  })
})
