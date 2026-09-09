import { describe, expect, it } from 'vitest'
import type { MeetingNotesContent, Segment, Transcript } from '../../../shared/types'
import { refineWriterAction } from '../notes-writer-grounding'
import { actionEvidenceNeighborhood, actionEvidenceTurns } from '../notes-action-evidence'
import { refineNextSteps } from '../notes-action-context'

function row(text: string, startMs = 1000, endMs = 2000, speaker = 'me'): Transcript {
  return { id: String(startMs), meetingId: 'm', text, startMs, endMs, speaker, confidence: 1 }
}
function draft(content: string, startMs = 1000, endMs = 1000): Segment {
  return {
    id: 'writer',
    meetingId: 'm',
    category: 'action_item',
    title: content,
    content,
    assignee: null,
    deadline: null,
    topic: null,
    sourceStartMs: startMs,
    sourceEndMs: endMs
  }
}
function content(): MeetingNotesContent {
  return { overview: null, keyTakeaways: [], sections: [], decisions: [], nextSteps: [] }
}

describe('Next Steps validation using existing writer drafts', () => {
  it.each([
    ['I will review the authentication contract.', 'I will review the authentication contract.'],
    ["I'll review return types.", 'Review return types.'],
    [
      "I'll send the API specification after Jordan has reviewed the draft.",
      'Send the API specification after Jordan has reviewed the draft.'
    ],
    [
      "We'll go ahead and follow up with the customer about the security report.",
      'Follow up with the customer about the security report.'
    ],
    ['I will just run the benchmark suite.', 'I will run the benchmark suite.']
  ])('preserves explicit commitments across ordinary wording: %s', (source, summary) => {
    expect(refineWriterAction(draft(summary), [row(source)])?.segment.content).toBe(summary)
  })

  it.each([
    [
      "Maybe I'll review the authentication contract.",
      'I will review the authentication contract.'
    ],
    ["If QA approves, I'll deploy build 443.", 'I will deploy build 443.'],
    ['I will not send the security report.', 'I will send the security report.'],
    ['Alice sent the security report yesterday.', 'Send the security report.'],
    ['Did you review the authentication contract?', 'Review the authentication contract.'],
    ["I'll review the authentication contract.", 'Send the authentication contract.'],
    ["I'll send the security report.", 'Send the security report to Sergio.'],
    ["I'll test build 443.", 'Test build 445.'],
    ["I'll ask where the migration stands.", 'The migration is complete.']
  ])(
    'does not turn uncertainty, status, or unsupported details into tasks: %s',
    (source, summary) => {
      expect(refineWriterAction(draft(summary), [row(source)])).toBeNull()
    }
  )

  it('uses context around a cited commitment without treating a complete embedded question as a fragment', () => {
    const rows = [
      row('There are more Mac issues to test.', 1000, 2000, 'them'),
      row("I'm not sure about Mac.", 3000, 4000, 'them'),
      row("Okay. I will ping Jordan after this to see where we're at.", 5000, 6000, 'them'),
      row('Release timing depends on Mac testing.', 7000, 8000, 'them')
    ]
    const candidate = draft(
      'I will ping Jordan after this to see where Mac testing is at.',
      5000,
      5000
    )
    expect(refineWriterAction(candidate, rows)?.segment.content).toBe(candidate.content)
    expect(refineWriterAction(draft('I will look at.'), [row('I will look at.')])).toBeNull()
    expect(
      refineWriterAction(
        candidate,
        rows.filter((r) => r.startMs !== 5000)
      )
    ).toBeNull()
  })

  it('reconstructs a continuous utterance across a contained ASR repeat and a backchannel', () => {
    const rows = [
      row(
        "There are different model configurations that I'm going to just run a bunch",
        1000,
        9000
      ),
      row('Thank you.', 3000, 4000, 'them'),
      row('different model configurations.', 4000, 5000),
      row('of benchmarks on my laptop.', 9000, 12_000)
    ]
    const original = structuredClone(rows)
    expect(actionEvidenceTurns(rows)).toEqual([
      {
        text: "There are different model configurations that I'm going to just run a bunch of benchmarks on my laptop.",
        rows: [rows[0], rows[3]]
      }
    ])
    const candidate = draft(
      'I will run benchmarks for different model configurations on my laptop.',
      1000,
      9000
    )
    expect(refineWriterAction(candidate, rows)?.segment.content).toBe(candidate.content)
    expect(rows).toEqual(original)
    expect(actionEvidenceTurns([rows[0], { ...rows[3], speaker: 'them' }])).toHaveLength(2)
    expect(actionEvidenceTurns([rows[0], { ...rows[3], startMs: 20_000 }])).toHaveLength(2)
  })

  it('upgrades the existing task once, retaining its identity, owner, deadline, and all other notes', () => {
    const rows = [
      row(
        "There are different model configurations that I'm going to just run a bunch",
        1000,
        9000
      ),
      row('of benchmarks on my laptop.', 9000, 12_000)
    ]
    const candidate = draft(
      'I will run benchmarks for different model configurations on my laptop.',
      1000,
      9000
    )
    const original = content()
    original.overview = { text: 'Accepted overview', sources: [], provenance: 'generated' }
    original.nextSteps = [
      {
        id: 'recovered-action:old',
        title: 'Run a bunch',
        text: 'Run a bunch.',
        topic: null,
        owner: 'Me',
        deadline: 'Friday',
        completed: true,
        provenance: 'generated',
        sources: [{ startMs: 1000, endMs: 9000 }]
      }
    ]
    const snapshot = structuredClone(original)
    const result = refineNextSteps(original, [candidate, candidate], rows)
    expect(result.content.nextSteps).toHaveLength(1)
    expect(result.content.nextSteps[0]).toMatchObject({
      id: 'recovered-action:old',
      owner: 'Me',
      deadline: 'Friday',
      completed: true,
      text: candidate.content
    })
    expect(result.content.overview).toBe(original.overview)
    expect(result.content.sections).toBe(original.sections)
    expect(result.content.keyTakeaways).toBe(original.keyTakeaways)
    expect(result.content.decisions).toBe(original.decisions)
    expect(original).toEqual(snapshot)
  })

  it('does not replace an existing task if the writer omitted its condition', () => {
    const original = content()
    original.nextSteps = [
      {
        id: 'old',
        title: 'Send the report',
        text: 'Send the report after QA approval.',
        topic: null,
        owner: null,
        deadline: null,
        provenance: 'generated',
        sources: [{ startMs: 1000, endMs: 2000 }]
      }
    ]
    const result = refineNextSteps(
      original,
      [draft('I will send the report.')],
      [row('I will send the report.')]
    )
    expect(result.content).toEqual(original)
  })

  it('does not duplicate an existing commitment using a different predicate from nearby context', () => {
    const rows = [
      row('The feature flag differences include inconsistent return types.', 1000, 2000, 'them'),
      row('I will set them to return the same type as well.', 3000, 5000, 'them'),
      row('I will go through this now and sweep through it manually as well.', 5000, 8000, 'them')
    ]
    const candidate = draft(
      'I will go through the feature flag differences manually and ensure consistent return types.',
      5000,
      5000
    )
    expect(refineWriterAction(candidate, rows)).not.toBeNull()
    const original = content()
    original.nextSteps = [
      {
        id: 'old',
        title: 'Set them to return the same type',
        text: 'Set them to return the same type as well.',
        topic: null,
        owner: null,
        deadline: null,
        provenance: 'generated',
        sources: [{ startMs: 3000, endMs: 5000 }]
      }
    ]
    expect(refineNextSteps(original, [candidate], rows).content).toBe(original)
  })

  it('retains the complete cited evidence instead of grounding only its generic tail', () => {
    const rows = [
      row('The feature flag differences include inconsistent return types.', 1000, 2000),
      row('I will review the feature flag differences.', 3000, 4000)
    ]
    const candidate = draft('I will review the feature flag differences.', 1000, 3000)
    expect(refineWriterAction(candidate, rows)?.segment.sourceStartMs).toBe(1000)
  })

  it('uses the end of a long source row to find adjacent context', () => {
    const rows = [
      row('An unrelated earlier topic.', 0, 1000),
      row('The feature flag comparison shows mismatched return types.', 20_000, 40_000),
      row('I will review those differences.', 40_000, 44_000)
    ]
    expect(actionEvidenceNeighborhood(rows, 40_000, 40_000)).toEqual(rows.slice(1))
    expect(actionEvidenceNeighborhood(rows, 90_000, 90_000)).toEqual([])
  })

  it('shares the recovery chatter rule without excluding a scoped conversation task', () => {
    const chatter = "I'll talk to you tomorrow and stand up"
    expect(refineNextSteps(content(), [draft(chatter)], [row(chatter)]).count).toBe(0)
    const scoped = "I'll talk to you tomorrow about the authentication contract."
    expect(
      refineNextSteps(content(), [draft(scoped)], [row(scoped)]).content.nextSteps[0]?.text
    ).toBe(scoped)
  })
})
