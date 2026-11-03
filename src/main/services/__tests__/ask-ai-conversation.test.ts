import { describe, expect, it } from 'vitest'
import {
  buildConversationWriterPrompt,
  buildConversationWriterInput,
  clipConversationText,
  conversationTokens,
  recentConversation
} from '../ask-ai-conversation'

const turn = (role: 'user' | 'assistant', content: string) => ({ role, content })
describe('bounded conversational context', () => {
  it('keeps ordered recent exchanges and removes an orphaned leading answer', () => {
    const history = [
      turn('user', 'Old '.repeat(200)),
      turn('assistant', 'Old answer '.repeat(100)),
      turn('user', 'Which route did we choose?'),
      turn('assistant', 'The rail route.'),
      turn('user', 'Who arranged that?'),
      turn('assistant', 'Keiko arranged it.')
    ]
    const bounded = recentConversation(history, 100)
    expect(bounded[0].role).toBe('user')
    expect(bounded.at(-1)?.content).toBe('Keiko arranged it.')
    expect(bounded.some((entry) => entry.content === 'Who arranged that?')).toBe(true)
    expect(conversationTokens(bounded.map((entry) => entry.content).join(''))).toBeLessThan(100)
  })
  it('bounds non-Latin text without splitting codepoints', () => {
    const text = clipConversationText('日本語🙂'.repeat(100), 30)
    expect(conversationTokens(text)).toBeLessThanOrEqual(30)
    expect(text).not.toContain('\ufffd')
  })
  it('distinguishes previous answers from current authoritative evidence', () => {
    const prompt = buildConversationWriterPrompt(
      'Is that still true?',
      [
        {
          meetingId: 'x',
          title: 'Rail review',
          date: 0,
          kind: 'note',
          text: 'Keiko changed the route to rail.'
        }
      ],
      { history: [turn('user', 'Which route?'), turn('assistant', 'Road.')], inventoryCount: 80 },
      2048,
      'Ground facts.'
    )
    expect(prompt).toContain('context only, not factual evidence')
    expect(prompt).toContain('Road.')
    expect(prompt).toContain('Keiko changed the route to rail.')
    expect(prompt).toContain('count: 80')
    expect(prompt).toContain('sample, not a complete library')
    expect(prompt.endsWith('Current user request: Is that still true?')).toBe(true)
  })
  it('adds the clipped newest-first recording list after the count only when supplied', () => {
    const base = { history: [], inventoryCount: 3 }
    const without = buildConversationWriterPrompt('Latest?', [], base, 2048, 'Ground facts.')
    const list = 'Vale review (2026-10-05); Ridge review (2026-09-01)'
    const withList = buildConversationWriterPrompt(
      'Latest?',
      [],
      { ...base, recordings: list },
      2048,
      'Ground facts.'
    )
    expect(withList).toBe(
      without.replace(
        'complete library.\n',
        `complete library.\nSaved recordings, newest first: ${list}\n`
      )
    )
    const clipped = buildConversationWriterPrompt(
      'Latest?',
      [],
      { ...base, recordings: 'Long title (2026-10-05); '.repeat(100) },
      2048,
      'Ground facts.'
    )
    const line = clipped.split('\n').find((entry) => entry.startsWith('Saved recordings'))!
    expect(
      conversationTokens(line.slice('Saved recordings, newest first: '.length))
    ).toBeLessThanOrEqual(Math.min(160, 2048 * 0.08))
  })
  it('tells a first turn without a dominant meeting to answer across meetings or ask, only when flagged', () => {
    const base = { history: [], inventoryCount: 3 }
    const without = buildConversationWriterPrompt('Risks?', [], base, 2048, 'Ground facts.')
    const spanning = buildConversationWriterPrompt(
      'Risks?',
      [],
      { ...base, spanning: true },
      2048,
      'Ground facts.'
    )
    expect(without).not.toContain('no single matching meeting')
    expect(spanning).toBe(
      without.replace(
        'Ask which meeting/topic if unspecified.',
        'Ask which meeting/topic if unspecified. Search found no single matching meeting: the evidence is the best passage from each of several meetings. If the request has a topic, answer across these meetings and name the meeting for each point. If it names no topic or meeting, ask which one instead of guessing.'
      )
    )
  })
  it('reserves output and instructions within the existing smallest context', () => {
    const system = 'Rules '.repeat(80)
    const prompt = buildConversationWriterPrompt(
      '質問'.repeat(300),
      Array.from({ length: 20 }, (_, i) => ({
        meetingId: String(i),
        title: '長い題名'.repeat(100),
        date: 0,
        kind: 'note' as const,
        text: '資料🙂'.repeat(500)
      })),
      {
        history: Array.from({ length: 8 }, (_, i) =>
          turn(i % 2 ? 'assistant' : 'user', '会話'.repeat(500))
        ),
        inventoryCount: 500
      },
      2048,
      system
    )
    expect(conversationTokens(prompt + system)).toBeLessThanOrEqual(2048 - 350)
    expect(prompt).toContain('Current user request:')
  })
  it('packs current evidence afresh instead of trusting the prior assistant claim', () => {
    const conversation = {
      history: [turn('user', 'What is the approved amount?'), turn('assistant', '$90,000.')],
      inventoryCount: 1
    }
    const make = (text: string) =>
      buildConversationWriterPrompt(
        'Please recheck.',
        [{ meetingId: 'x', title: 'Finance', date: 0, kind: 'note', text }],
        conversation,
        2048,
        'Use only evidence.'
      )
    expect(make('Approved amount $12,000.')).toContain('Approved amount $12,000.')
    expect(make('Approved amount $11,000.')).not.toContain('Approved amount $12,000.')
  })
})

it('keeps the latest numbered answer whole up to600 estimated tokens and clips older answers', () => {
  const answer =
    '1. Inspect the brass assembly before replacing it. '.repeat(28) +
    '2. Send the numbered reminder to Tessa.'
  const history = [
    turn('user', 'Earlier question'),
    turn('assistant', 'Older material. '.repeat(100)),
    turn('user', 'List the two actions.'),
    turn('assistant', answer)
  ]
  const input = buildConversationWriterInput(
    'Make the second item a reminder.',
    [],
    { history, inventoryCount: 2 },
    4096,
    'Ground facts.'
  )
  expect(input.history.at(-1)?.content).toBe(answer)
  expect(
    input.history.find((t) => t.content.startsWith('Older material'))?.content.length ?? 0
  ).toBeLessThanOrEqual(510)
  expect(input.history.at(-2)?.content).toBe('List the two actions.')
})
it('caps the most recent dense answer at600 tokens without losing its preceding user turn', () => {
  const bounded = recentConversation([
    turn('user', 'List the steps.'),
    turn('assistant', '資料🙂'.repeat(500))
  ])
  expect(bounded[0].role).toBe('user')
  expect(conversationTokens(bounded.at(-1)!.content)).toBeLessThanOrEqual(600)
  expect(conversationTokens(bounded.at(-1)!.content)).toBeGreaterThan(170)
  expect(bounded.at(-1)!.content).not.toContain('\ufffd')
})
