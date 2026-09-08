import { afterEach, expect, it, vi } from 'vitest'
import { countCompleteOutlineBullets, outlineToWriterJson } from '../windows-notes-outline'
import { OllamaProvider, shouldStopWindowsTightWriterStream } from '../llm'
import { isWindowsTopicWriterEnabled } from '../windows-notes-experiment'

const platform = process.platform
afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
})

it('retains a shared heading, category and exact source references without rewriting sentences', () => {
  const result = JSON.parse(outlineToWriterJson('## Venue\n- Decision: The library will host the workshop. [L3-L6]\n- Action: Renée will confirm the booking by Friday. [L8-L9]\n## Budget\n- Fact: The budget remains $400. [L11]'))
  expect(result).toEqual({
    d: [['Venue', 'The library will host the workshop.', 3, 6]],
    a: [['Venue', 'Renée will confirm the booking by Friday.', 8, 9]],
    i: [['Budget', 'The budget remains $400.', 11, 11]]
  })
})

it('does not count an unfinished bullet or accept uncited prose and invalid source ranges', () => {
  const raw = '## Venue\n- Fact: The library will host the workshop. [L3-L6]\n- Action: Renée will confirm'
  expect(countCompleteOutlineBullets(raw)).toBe(1)
  expect(countCompleteOutlineBullets(raw.replace('- Fact:', 'Fact:'))).toBe(1)
  expect(JSON.parse(outlineToWriterJson(raw)).i).toHaveLength(1)
  for (const invalid of ['- Fact: No heading. [L1]', '## Venue\n- Fact: Reversed source. [L9-L2]', '## Venue\nUncited prose.']) expect(outlineToWriterJson(invalid)).toBe(invalid)
})

it('accepts punctuation after citations and Markdown emphasis without changing the claim', () => {
  for (const label of ['Fact:', '**Fact:**', '**Fact**:']) {
    const raw = `### Venue\n- ${label} The library will host the workshop [L3-L6].`
    expect(countCompleteOutlineBullets(raw)).toBe(1)
    expect(JSON.parse(outlineToWriterJson(raw))).toEqual({ i: [['Venue', 'The library will host the workshop.', 3, 6]] })
  }
})

it('only changes the Windows opt-in writer and caps complete cited bullets', () => {
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', 'outline')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const provider = new OllamaProvider('http://localhost:11435', 'qwen3:4b-instruct')
  expect((provider as any).getSystemPrompt()).toContain('Markdown')
  const information = Array.from({ length: 15 }, (_, i) => ({ topic: `Subject ${i}`, sourceStartMs: i }))
  expect((provider as any).extractKnownTopics({information, decisions: [], actionItems: [], discussion: [], statusUpdates: []})).toEqual(information.slice(-12).map(row => row.topic))
  const raw = '## Venue\n' + '- Fact: The library will host the workshop. [L3-L6]\n'.repeat(6)
  expect(shouldStopWindowsTightWriterStream(raw)).toBe(true)
  expect(isWindowsTopicWriterEnabled('darwin', 'outline')).toBe(false)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  const mac = (provider as any).getSystemPrompt()
  vi.stubEnv('AUTODOC_TEST_WINDOWS_TOPIC_WRITER', '')
  expect((provider as any).getSystemPrompt()).toBe(mac)
})
