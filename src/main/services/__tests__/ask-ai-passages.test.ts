import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskAiPassages } from '../ask-ai-passages'
import { directEvidenceAnswer } from '../ask-ai-evidence'
import type { IndexedMeeting } from '../meeting-index'
const hardware = vi.hoisted(() => ({ append: false }))
vi.mock('../mac-processing-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => hardware.append
}))
vi.mock('../crypto', () => ({
  decryptJSON: vi.fn(async () => {
    throw Error('Missing derived test cache')
  }),
  encryptJSON: vi.fn(async () => undefined)
}))
afterEach(() => vi.unstubAllEnvs())

it('changes only passage-ID metadata when append is enabled, preserving retrieval order and carry', async () => {
  const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
  const index = new AskAiPassages(provider, '/unused/cache')
  const meetings = [fixture()]
  const history = [{ role: 'user' as const, content: 'Summarize Atlas migration.' }]
  const retrieve = () =>
    index.retrieveConversation(
      'Who owns it and what is the budget?',
      meetings,
      history,
      ['atlas'],
      undefined,
      undefined,
      () => false,
      ['atlas']
    )
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '0')
  const off = await retrieve()
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', '1')
  const on = await retrieve()
  expect(on?.excerpts?.length).toBeGreaterThan(0)
  const actualPassages = (
    index as unknown as { passages(m: IndexedMeeting[]): Array<{ key: string; text: string }> }
  ).passages(meetings)
  for (const excerpt of on!.excerpts!)
    expect(actualPassages.find((p) => p.key === excerpt.passageId)?.text).toBe(excerpt.text)
  const withoutIds = {
    ...on,
    excerpts: on!.excerpts!.map(({ passageId: _passageId, ...excerpt }) => excerpt)
  }
  expect(JSON.stringify(withoutIds)).toBe(JSON.stringify(off))
})

function fixture(signature = 'regenerated'): IndexedMeeting {
  return {
    meetingId: 'atlas',
    title: 'Atlas launch review',
    date: Date.UTC(2026, 9, 12),
    dir: '/unused',
    sourceName: 'Atlas',
    signature,
    noteEntries: [
      {
        id: 'budget',
        title: 'Atlas migration budget',
        topic: 'Atlas migration',
        content: 'The approved budget is $47,250.',
        category: 'information',
        owner: null,
        deadline: null,
        sources: [{ startMs: 0, endMs: 30000 }]
      },
      {
        id: 'launch',
        title: 'Atlas migration launch date',
        topic: 'Atlas migration',
        content: 'The launch is October 23, 2026.',
        category: 'information',
        owner: null,
        deadline: null,
        sources: [{ startMs: 0, endMs: 30000 }]
      }
    ],
    transcriptChunks: [
      {
        id: 't1',
        text: 'Mira owns the Atlas migration. The approved budget is $47,250. The team rejected a November launch.',
        startMs: 0,
        endMs: 30000
      },
      {
        id: 't2',
        text: 'The emergency rollback passphrase is cedar falcon.',
        startMs: 30000,
        endMs: 60000
      }
    ]
  }
}

describe('passage evidence coverage and busy admission', () => {
  it('retains transcript-only facts when a detailed summary explicitly asks for them', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const result = await index.retrieve(
      'Summarize all the recorded Atlas facts, including transcript-only details.',
      [fixture()],
      undefined,
      undefined,
      () => false
    )
    expect(result?.excerpts?.some((e) => e.text.includes('cedar falcon'))).toBe(true)
    expect(result?.excerpts?.some((e) => e.text.includes('$47,250'))).toBe(true)
  })
  it('does not drop a longer transcript merely because it contains the notes verbatim', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const meeting = fixture()
    meeting.noteEntries = [
      {
        ...meeting.noteEntries[0],
        title: 'Overview',
        content: 'Mira owns Atlas. The budget is $47,250.'
      }
    ]
    meeting.transcriptChunks = [
      {
        id: 'combined',
        text: 'me: Mira owns Atlas. The budget is $47,250. The emergency rollback passphrase is cedar falcon.',
        startMs: 0,
        endMs: 60000
      }
    ]
    const result = await index.retrieve(
      'Summarize all the recorded Atlas facts, including transcript-only details.',
      [meeting],
      undefined,
      undefined,
      () => false
    )
    expect(result?.excerpts?.some((e) => e.text.includes('cedar falcon'))).toBe(true)
  })
  it('finds the owner in transcript after generated notes omit it, without any model calls while busy', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => true), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const result = await index.retrieve(
      'Who owns the Atlas migration?',
      [fixture()],
      undefined,
      undefined,
      () => false
    )
    expect(provider.isAvailable).not.toHaveBeenCalled()
    expect(provider.embed).not.toHaveBeenCalled()
    expect(
      result?.sources?.some(
        (source) => source.category === 'transcript' && source.quote.includes('Mira')
      )
    ).toBe(true)
    expect(directEvidenceAnswer('Who owns the Atlas migration?', result!)).toContain(
      'Mira owns the Atlas migration.'
    )
  })

  it('keeps timestamped transcript-only facts and never substitutes them for an unknown key', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const passphrase = await index.retrieve(
      'What is the Atlas emergency rollback passphrase?',
      [fixture()],
      undefined,
      undefined,
      () => false
    )
    expect(passphrase?.sources?.some((source) => source.startMs === 30000)).toBe(true)
    expect(
      directEvidenceAnswer('What is the Atlas emergency rollback passphrase?', passphrase!)
    ).toContain('cedar falcon')
    expect(
      await index.retrieve(
        'What is the Atlas encryption key?',
        [fixture()],
        undefined,
        undefined,
        () => false
      )
    ).toBeNull()
  })

  it('refreshes source passages when notes are regenerated', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const before = fixture('before')
    before.transcriptChunks = []
    await index.retrieve('What is the Atlas budget?', [before], undefined, undefined, () => false)
    const after = fixture('after')
    const result = await index.retrieve(
      'Who is responsible for moving Atlas?',
      [after],
      undefined,
      undefined,
      () => false
    )
    expect(directEvidenceAnswer('Who is responsible for moving Atlas?', result!)).toContain('Mira')
  })

  it('does not transfer a migration owner to an unsupported security/product owner question', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    for (const q of ['Who owns Atlas security?', 'Who owns the Atlas product?'])
      expect(await index.retrieve(q, [fixture()], undefined, undefined, () => false)).toBeNull()
  })

  it('does not invent a synthetic answer or hide conflicting factual evidence', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const meeting = fixture()
    meeting.transcriptChunks[0].text = 'The approved budget is $40,000.'
    const result = await index.retrieve(
      'What is the Atlas budget?',
      [meeting],
      undefined,
      undefined,
      () => false
    )
    const direct = directEvidenceAnswer('What is the Atlas budget?', result!)!
    expect(direct).toContain('$47,250')
    expect(direct).toContain('$40,000')
    expect(direct.startsWith('>')).toBe(true)
    expect(directEvidenceAnswer('Explain the Atlas budget', result!)).toBeNull()
  })
  it('keeps semantic retrieval available when a source uses another language or vocabulary', async () => {
    const provider = {
      model: 'test',
      isAvailable: vi.fn(async () => true),
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    }
    const index = new AskAiPassages(provider, '/tmp/ad122-routing-test/cache.enc')
    const meeting = fixture('native-source')
    meeting.title = 'Réunion budget agricole'
    meeting.noteEntries[0].content = 'Le plafond proposé est de 150 000 euros.'
    meeting.transcriptChunks = []
    const result = await index.retrieve(
      'What precautionary agricultural savings ceiling was proposed?',
      [meeting]
    )
    expect(provider.embed).toHaveBeenCalled()
    expect(result?.sources?.some((source) => source.quote.includes('150 000'))).toBe(true)
    expect(
      directEvidenceAnswer('What precautionary agricultural savings ceiling was proposed?', result!)
    ).toBeNull()
  })
  it('labels owners and deadlines so they read differently from other dates', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const meeting = fixture()
    meeting.noteEntries = [
      {
        ...meeting.noteEntries[0],
        title: 'Seating diagram',
        topic: null,
        content: 'Send the seating diagram.',
        owner: 'Leah Voss',
        deadline: '2025-04-16'
      }
    ]
    const result = await index.retrieve(
      'Who sends the seating diagram?',
      [meeting],
      undefined,
      undefined,
      () => false
    )
    expect(
      result?.excerpts?.some((e) => e.text.includes('Owner: Leah Voss · Due: 2025-04-16'))
    ).toBe(true)
  })
  it('preserves fractional amounts and abbreviated dates in cited evidence', async () => {
    const provider = { model: 'test', isAvailable: vi.fn(async () => false), embed: vi.fn() }
    const index = new AskAiPassages(provider, '/unused/cache')
    const meeting = fixture('fractional-facts')
    meeting.noteEntries[0].content =
      'The approved budget is $47.25 million. The launch is Jan. 4, 2027.'
    meeting.noteEntries = [meeting.noteEntries[0]]
    meeting.transcriptChunks = []
    for (const q of ['What is the Atlas budget?', 'When will Atlas launch?']) {
      const result = await index.retrieve(q, [meeting], undefined, undefined, () => false)
      const answer = directEvidenceAnswer(q, result!)
      expect(answer).toContain('$47.25 million')
      expect(answer).toContain('Jan. 4, 2027')
    }
  })
  it('leaves earlier proposals and later decisions across meetings to the writer', () => {
    const answer = {
      intent: 'lookup' as const,
      content: '',
      selectedMeetingIds: ['old', 'new'],
      selectedTitles: [],
      sources: [
        {
          meetingId: 'old',
          title: 'Atlas earlier proposal',
          quote: 'The proposed Atlas budget was $91,000. It was rejected.',
          n: 1,
          startMs: 0,
          category: 'note' as const
        },
        {
          meetingId: 'new',
          title: 'Atlas launch review',
          quote: 'The approved budget is $47,250.',
          n: 2,
          startMs: 0,
          category: 'note' as const
        }
      ]
    }
    expect(directEvidenceAnswer('What is the approved Atlas budget?', answer)).toBeNull()
  })
})

it.each([2, 20])(
  'accepts the same distinctive initial topic in a %i-meeting library',
  async (size) => {
    const meetings = Array.from({ length: size }, (_, i) => {
      const meeting = fixture()
      meeting.meetingId = `meeting-${i}`
      meeting.title = `Workshop ${i}`
      meeting.signature = `revision-${i}`
      meeting.noteEntries = [
        {
          ...meeting.noteEntries[0],
          title: 'Overview',
          topic: null,
          content: i === 0 ? 'Cora handles orchid consent.' : 'Routine equipment inspection.'
        }
      ]
      meeting.transcriptChunks = []
      return meeting
    })
    const provider = {
      model: 'test',
      isAvailable: vi.fn(async () => true),
      embed: vi.fn(async (texts: string[]) =>
        texts.map((text) =>
          text.startsWith('Instruct:')
            ? [1, 0]
            : text.includes('orchid')
              ? [0.5, Math.sqrt(0.75)]
              : [0.2, Math.sqrt(0.96)]
        )
      )
    }
    const result = await new AskAiPassages(
      provider,
      join(tmpdir(), 'autodoc-conversation-unit.enc')
    ).retrieveConversation('What about orchid?', meetings, [])
    expect(result?.retrievalConfidence?.confident).toBe(true)
    expect(result?.sources?.some((source) => source.meetingId === 'meeting-0')).toBe(true)
  }
)

it('adds passage IDs on the qualifying tier default without an environment opt-in', async () => {
  vi.resetModules()
  hardware.append = true
  vi.stubEnv('AUTODOC_ASK_AI_APPEND_FOLLOWUPS', undefined)
  const { AskAiPassages: DefaultPassages } = await import('../ask-ai-passages')
  const index = new DefaultPassages(
    { model: 'test', isAvailable: async () => false, embed: vi.fn() },
    '/unused'
  )
  const result = await index.retrieveConversation(
    'Who owns Atlas migration?',
    [fixture()],
    [],
    undefined,
    undefined,
    undefined,
    () => false
  )
  expect(result?.excerpts?.length).toBeGreaterThan(0)
  for (const excerpt of result!.excerpts!) expect(excerpt.passageId).toBeTruthy()
  hardware.append = false
  vi.resetModules()
})

describe('multi-meeting retrieval breadth', () => {
  // Cosine against the [1, 0] query is the first component of each vector.
  const spread = (cosines: Record<string, number>) => {
    const meetings = [...Object.keys(cosines), 'grey'].map((colour) => {
      const meeting = fixture()
      meeting.meetingId = colour
      meeting.title = `${colour} sync`
      meeting.signature = `sig-${colour}`
      const entry = (id: string, content: string) => ({
        ...meeting.noteEntries[0],
        id,
        title: 'Notes',
        topic: null,
        content
      })
      meeting.noteEntries = [
        entry('a', `${colour} first item`),
        entry('b', `${colour} second item`),
        entry('c', `${colour} third item`)
      ]
      meeting.transcriptChunks = []
      return meeting
    })
    const provider = {
      model: 'test',
      isAvailable: vi.fn(async () => true),
      embed: vi.fn(async (texts: string[]) =>
        texts.map((text) => {
          const c = Object.entries(cosines).find(([colour]) => text.includes(colour))?.[1]
          return text.startsWith('Instruct:') ? [1, 0] : c ? [c, Math.sqrt(1 - c * c)] : [0, 1]
        })
      )
    }
    return {
      meetings,
      index: new AskAiPassages(provider, join(tmpdir(), 'autodoc-breadth-unit.enc'))
    }
  }
  const diffuse = { red: 0.62, blue: 0.5, green: 0.47, amber: 0.44 }

  it('takes a passage from every relevant meeting when no meeting dominates a first question', async () => {
    const { meetings, index } = spread(diffuse)
    let ranked: string[] = []
    const result = await index.retrieveConversation(
      'What was raised overall?',
      meetings,
      [],
      [],
      undefined,
      undefined,
      undefined,
      [],
      (ids) => (ranked = ids)
    )
    expect(result?.retrievalConfidence?.confident).toBe(false)
    expect(new Set(result?.selectedMeetingIds)).toEqual(new Set(Object.keys(diffuse)))
    expect(ranked).toEqual(['red', 'blue', 'green', 'amber'])
    expect(result?.excerpts?.length).toBe(8)
    expect(result?.excerpts?.filter((e) => e.meetingId === 'grey')).toEqual([])
  })

  it('keeps a follow-up with history on the narrow single-match window', async () => {
    const { meetings, index } = spread(diffuse)
    const result = await index.retrieveConversation('What was raised overall?', meetings, [
      { role: 'user', content: 'Summarize the meetings.' }
    ])
    expect(result?.selectedMeetingIds).toEqual(['red'])
    expect(result?.excerpts?.length).toBe(3)
  })

  it('does not widen a confident first question beyond the single-match window', async () => {
    const { meetings, index } = spread({ red: 0.7, blue: 0.41 })
    const result = await index.retrieveConversation('What was raised overall?', meetings, [])
    expect(result?.retrievalConfidence?.confident).toBe(true)
    expect(result?.selectedMeetingIds).toEqual(['red'])
  })

  it('does not widen a first question that names a meeting by title', async () => {
    const { meetings, index } = spread({ red: 0.5, blue: 0.45, amber: 0.41 })
    const result = await index.retrieveConversation('What was raised in red?', meetings, [])
    expect(result?.retrievalConfidence?.confident).toBe(false)
    expect(new Set(result?.selectedMeetingIds)).toEqual(new Set(['red', 'blue']))
  })
})
