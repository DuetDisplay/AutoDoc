import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AskAiPassages } from '../ask-ai-passages'
import { buildConversationWriterInput } from '../ask-ai-conversation'
import type { IndexedMeeting } from '../meeting-index'
vi.mock('../crypto', () => ({
  decryptJSON: vi.fn(async () => {
    throw Error('No fixture cache')
  }),
  encryptJSON: vi.fn(async () => undefined)
}))
function meeting(id: string, title: string, content: string): IndexedMeeting {
  return {
    meetingId: id,
    title,
    date: 0,
    dir: '/unused',
    sourceName: title,
    signature: id,
    noteEntries: [
      {
        id,
        title: 'Overview',
        topic: null,
        content,
        category: 'information',
        owner: null,
        deadline: null,
        sources: []
      }
    ],
    transcriptChunks: []
  }
}
describe('confirmed conversation retrieval fixes', () => {
  it('labels earlier matches without claiming they were cited', () => {
    const input = buildConversationWriterInput(
      'What changed?',
      [{ meetingId: 'a', title: 'Workshop', date: 0, kind: 'note', text: 'New brass fasteners.' }],
      { history: [], inventoryCount: 1, focusedMeetingIds: ['a'] },
      2048,
      'Use evidence.'
    )
    expect(input.context).toContain('earlier search match')
    expect(input.context).not.toContain('previously cited')
  })
  it('does not admit a previous meeting merely because it is in the prior result set', async () => {
    const index = new AskAiPassages(
      { model: 'test', isAvailable: async () => false, embed: vi.fn() },
      join(tmpdir(), 'autodoc-conversation-fixes-test', 'cache.enc')
    )
    const result = await index.retrieveConversation(
      'Harbor mounting',
      [
        meeting('a', 'Workshop', 'Violet shutters require brass fasteners.'),
        meeting('b', 'Harbor', 'Mounting uses steel screws.')
      ],
      [
        { role: 'user', content: 'Continue.' },
        { role: 'assistant', content: 'Certainly.' }
      ],
      ['a'],
      undefined,
      undefined,
      () => false
    )
    expect(result?.selectedMeetingIds).toEqual(['b'])
  })
  it('does not treat only short generic terms as lexical confidence in a semantic tie', async () => {
    const provider = {
      model: 'test',
      isAvailable: async () => true,
      embed: async (texts: string[]) =>
        texts.map((text) =>
          text.startsWith('Instruct:')
            ? [1, 0]
            : text.includes('Who is for it')
              ? [0.5, Math.sqrt(0.75)]
              : [0.49, Math.sqrt(1 - 0.49 ** 2)]
        )
    }
    const result = await new AskAiPassages(
      provider,
      join(tmpdir(), 'autodoc-conversation-fixes-test', 'cache.enc')
    ).retrieveConversation(
      'Who is for it?',
      [
        meeting('a', 'Workshop', 'Who is for it remains unclear.'),
        meeting('b', 'Review', 'Routine inspection proceeds.')
      ],
      []
    )
    expect(result?.retrievalConfidence?.confident).toBe(false)
  })
})

it('carries only two primary meetings and two question-ranked passages from each within eight', async () => {
  const meetings = ['a', 'b', 'c'].map((id) => {
    const m = meeting(id, `Workshop ${id}`, `Unrelated material ${id}.`)
    m.noteEntries.push(
      ...['schedule', 'storage', 'hardware'].map((word) => ({
        ...m.noteEntries[0],
        id: word,
        content: `${word} detail ${id}.`
      }))
    )
    return m
  })
  const index = new AskAiPassages(
    { model: 'test', isAvailable: async () => false, embed: vi.fn() },
    join(tmpdir(), 'autodoc-carry-test', 'cache.enc')
  )
  const result = await index.retrieveConversation(
    'What is the schedule?',
    meetings,
    [],
    [],
    undefined,
    undefined,
    () => false,
    ['a', 'b', 'c']
  )
  expect(result!.excerpts!.length).toBeLessThanOrEqual(8)
  for (const id of ['a', 'b']) {
    const passages = result!.excerpts!.filter((e) => e.meetingId === id)
    expect(passages).toHaveLength(2)
    expect(passages.some((e) => e.text.includes('schedule detail'))).toBe(true)
  }
})
it('a named meeting replaces carried meetings instead of automatically adding them', async () => {
  const index = new AskAiPassages(
    { model: 'test', isAvailable: async () => false, embed: vi.fn() },
    join(tmpdir(), 'autodoc-carry-test', 'cache.enc')
  )
  const result = await index.retrieveConversation(
    'Harbor mounting',
    [
      meeting('a', 'Workshop', 'Violet shutters require brass fasteners.'),
      meeting('b', 'Harbor', 'Mounting uses steel screws.')
    ],
    [],
    [],
    undefined,
    undefined,
    () => false,
    ['a']
  )
  expect(result?.selectedMeetingIds).toEqual(['b'])
  expect(result?.primaryMeetingIds).toEqual(['b'])
})
it('chooses the highest-ranked passage meeting before stable citation sorting', async () => {
  const provider = {
    model: 'test',
    isAvailable: async () => true,
    embed: async (texts: string[]) =>
      texts.map((text) =>
        text.startsWith('Instruct:') ? [1, 0] : text.includes('new bench') ? [0.8, 0.6] : [0.6, 0.8]
      )
  }
  const result = await new AskAiPassages(
    provider,
    join(tmpdir(), 'autodoc-carry-test', 'cache.enc')
  ).retrieveConversation(
    'calibration inspection readiness certification',
    [
      meeting(
        'a',
        'Workshop Alpha',
        'Calibration inspection readiness certification on old bench.'
      ),
      meeting('z', 'Workshop Zeta', 'Calibration inspection readiness certification on new bench.')
    ],
    []
  )
  expect(result?.excerpts?.[0].meetingId).toBe('a')
  expect(result?.primaryMeetingIds).toEqual(['z'])
})
