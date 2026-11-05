import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { AskAiPassages } from '../ask-ai-passages'
import { reserveAskAiTopMatch, useAskAiTopMatch } from '../ask-ai-top-match'
import type { IndexedMeeting } from '../meeting-index'

vi.mock('../crypto', () => ({
  decryptJSON: vi.fn(async () => {
    throw Error('No cache')
  }),
  encryptJSON: vi.fn(async () => undefined)
}))
vi.mock('../mac-processing-profile', async (original) => ({
  ...(await original<typeof import('../mac-processing-profile')>()),
  macUsesAskAiAppendFollowups: () => false
}))
afterEach(() => vi.unstubAllEnvs())
const row = (key: string, meetingId = key, text = key) => ({ key, meetingId, text })
function swap(
  picked: ReturnType<typeof row>[],
  candidate: ReturnType<typeof row> | undefined,
  extra: {
    named?: boolean
    eligible?: Set<string>
    carried?: Set<string>
  } = {}
) {
  const counts = new Map<string, number>()
  for (const p of picked) counts.set(p.meetingId, (counts.get(p.meetingId) ?? 0) + 1)
  reserveAskAiTopMatch(picked, candidate, {
    named: false,
    eligible: new Set(candidate ? [candidate.meetingId] : []),
    carried: new Set(),
    counts,
    ...extra
  })
  return counts
}
it('is on unless AUTODOC_ASK_AI_TOP_MATCH is 0', () => {
  expect(useAskAiTopMatch()).toBe(true)
  vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '0')
  expect(useAskAiTopMatch()).toBe(false)
})
it('replaces the last-added row', () => {
  const picked = Array.from({ length: 8 }, (_, i) => row(String(i)))
  swap(picked, row('best'))
  expect(picked.map((p) => p.key)).toEqual(['0', '1', '2', '3', '4', '5', '6', 'best'])
})
it.each(['already picked', 'same normalized text'])(
  'preserves card bytes when the best match is %s',
  (mode) => {
    const control = [row('first'), row('last')]
    swap(control, row('best'))
    expect(control.at(-1)?.key).toBe('best')
    const picked = [row('first', 'first', 'Overview · Shared answer'), row('last')]
    const before = JSON.stringify(picked)
    swap(
      picked,
      mode === 'already picked' ? picked[0] : row('best', 'other', 'speaker 2: Shared answer')
    )
    expect(JSON.stringify(picked)).toBe(before)
  }
)
it.each(['named', 'ineligible', 'all carried', 'no vector candidate'])(
  'leaves %s passages alone',
  (mode) => {
    const control = [row('first'), row('last')]
    swap(control, row('best'))
    expect(control.at(-1)?.key).toBe('best')
    const picked = [row('first'), row('last')],
      before = JSON.stringify(picked)
    swap(picked, mode === 'no vector candidate' ? undefined : row('best'), {
      named: mode === 'named',
      eligible: mode === 'ineligible' ? new Set() : new Set(['best']),
      carried: mode === 'all carried' ? new Set(['first', 'last']) : new Set()
    })
    expect(JSON.stringify(picked)).toBe(before)
  }
)
it('removes that meeting’s last row at its cap and never removes a carried row', () => {
  const picked = [row('a1', 'a'), row('a2', 'a'), row('a3', 'a'), row('carry'), row('last')]
  const counts = swap(picked, row('best', 'a'), { carried: new Set(['carry']) })
  expect(picked.map((p) => p.key)).toEqual(['a1', 'a2', 'best', 'carry', 'last'])
  expect(counts.get('a')).toBe(3)
  swap(picked, row('second'), { carried: new Set(['last', 'carry']) })
  expect(picked.slice(-2).map((p) => p.key)).toEqual(['carry', 'last'])
})
function fixture() {
  const meetings: IndexedMeeting[] = Array.from({ length: 10 }, (_, i) => ({
    meetingId: String(i),
    title: `Record ${i}`,
    date: 0,
    dir: '/unused',
    sourceName: null,
    signature: String(i),
    transcriptChunks: [],
    noteEntries: [
      {
        id: 'note',
        title: 'Overview',
        topic: null,
        content:
          i === 9
            ? 'Unrelated wording with a semantically exact answer.'
            : `Owner reviewed budget deadline staffing risk entry ${i}.`,
        category: 'information',
        owner: null,
        deadline: null,
        sources: []
      }
    ]
  }))
  const provider = {
    model: 'synthetic',
    isAvailable: vi.fn(async () => true),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((text) =>
        text.startsWith('Instruct:')
          ? [1, 0]
          : text.includes('semantically exact')
            ? [0.95, Math.sqrt(1 - 0.95 ** 2)]
            : [0.5, Math.sqrt(0.75)]
      )
    )
  }
  return {
    meetings,
    index: new AskAiPassages(provider, join(tmpdir(), 'autodoc-top-match-test', 'passages.enc'))
  }
}
it('wires reservation after normal selection without changing confidence, primary IDs or flag-off result bytes', async () => {
  const { meetings, index } = fixture()
  const question = 'Which owner reviewed budget deadline staffing risk?'
  vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '0')
  const baseline = await index.retrieveConversation(question, meetings, [])
  expect(baseline?.selectedMeetingIds).not.toContain('9')
  vi.unstubAllEnvs()
  const on = await index.retrieveConversation(question, meetings, [])
  expect(on?.selectedMeetingIds).toContain('9')
  expect(on?.primaryMeetingIds).toEqual(baseline?.primaryMeetingIds)
  expect(on?.retrievalConfidence).toEqual(baseline?.retrievalConfidence)
  expect(on?.sources).toHaveLength(8)
  vi.stubEnv('AUTODOC_ASK_AI_TOP_MATCH', '0')
  expect(JSON.stringify(await index.retrieveConversation(question, meetings, []))).toBe(
    JSON.stringify(baseline)
  )
})
