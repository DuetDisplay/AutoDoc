import { describe, expect, it, vi } from 'vitest'
import { AskAiPassages, writerSizedPassages } from '../ask-ai-passages'
vi.mock('../crypto', () => ({ decryptJSON: vi.fn(async () => { throw Error('No test cache') }), encryptJSON: vi.fn(async () => undefined) }))
import { conversationTokens } from '../ask-ai-conversation'

describe('writer-sized semantic passage index', () => {
  it('retains the sizing cache identity after provider identity resolves', async () => {
    const provider = { model: 'test-model', cacheIdentity: 'test-digest', isAvailable: async () => true, embed: async (texts: string[]) => texts.map(() => [1, 0]) }
    const index = new AskAiPassages(provider, '/unused/cache')
    await index.prepare([])
    expect((index as unknown as { version: string }).version).toContain('test-digest:writer180-overlap40:')
    await index.prepare([])
    expect((index as unknown as { version: string }).version).toContain('test-digest:writer180-overlap40:')
  })
  it('retains late source sentences whole across dense scripts', () => {
    const fact = '予備の鍵は受付の青い箱に保管されています。'
    const rows = writerSizedPassages('窓の清掃について確認しました。'.repeat(15) + fact)
    expect(rows.some((row) => row.includes(fact))).toBe(true)
    expect(rows.every((row) => conversationTokens(row) <= 180)).toBe(true)
  })
  it('covers every codepoint even in an unpunctuated long source', () => {
    const text = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
    const rows = writerSizedPassages(text)
    expect([...text].every((char) => rows.some((row) => row.includes(char)))).toBe(true)
    expect(rows.every((row) => conversationTokens(row) <= 180)).toBe(true)
  })
  it('keeps already-small note entries intact', () => {
    const note = 'Decision: rail approved; van rejected. Owner: Elif. The year is not recorded.'
    expect(writerSizedPassages(note)).toEqual([note])
  })
})
